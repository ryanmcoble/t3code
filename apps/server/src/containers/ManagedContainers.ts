import {
  ContainerError,
  ManagedContainerCreate,
  type ManagedContainer,
  type ManagedContainerInventory,
  type ManagedContainerCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ManagedContainerDriver from "./ManagedContainerDriver.ts";

export class ManagedContainers extends Context.Service<
  ManagedContainers,
  {
    readonly list: (
      threadId?: ThreadId,
    ) => Effect.Effect<typeof ManagedContainerInventory.Type, ContainerError>;
    readonly create: (
      input: typeof ManagedContainerCreate.Type,
    ) => Effect.Effect<ManagedContainer, ContainerError>;
    readonly command: (
      input: typeof ManagedContainerCommand.Type,
    ) => Effect.Effect<ManagedContainer, ContainerError>;
  }
>()("t3/containers/ManagedContainers") {}

interface StoredResource {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly root: string;
  readonly requestId: string;
  readonly engineId: string;
  readonly containerId: string | null;
  readonly name: string;
  readonly specification: string;
  readonly phase: ManagedContainer["phase"];
  readonly generation: number;
  readonly retained: number;
  readonly failure: string | null;
}
const specificationCodec = Schema.fromJsonString(ManagedContainerCreate);
const decodeSpecification = Schema.decodeUnknownOption(specificationCodec);
const encodeSpecification = Schema.encodeSync(specificationCodec);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const driver = yield* ManagedContainerDriver.ManagedContainerDriver;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gate = yield* Semaphore.make(1);
  const read = (id?: string, threadId?: ThreadId) =>
    sql<StoredResource>`SELECT r.id,r.workspace_id AS "workspaceId",w.thread_id AS "threadId",w.project_id AS "projectId",w.root,r.request_id AS "requestId",r.engine_id AS "engineId",r.container_id AS "containerId",r.name,r.specification_json AS specification,r.phase,r.generation,r.retained,r.failure FROM execution_containers r JOIN execution_workspaces w ON w.id=r.workspace_id WHERE (${id ?? null} IS NULL OR r.id=${id ?? null}) AND (${threadId ?? null} IS NULL OR w.thread_id=${threadId ?? null} OR EXISTS(SELECT 1 FROM execution_container_references refs WHERE refs.resource_id=r.id AND refs.thread_id=${threadId ?? null})) ORDER BY r.updated_at DESC,r.id LIMIT 1001`.pipe(
      Effect.mapError(() => new ContainerError({ reason: "storage" })),
    );
  const references = (id: string) =>
    sql<{
      readonly threadId: ThreadId;
    }>`SELECT thread_id AS "threadId" FROM execution_container_references WHERE resource_id=${id} ORDER BY thread_id`.pipe(
      Effect.map((rows) => rows.map((row) => row.threadId)),
      Effect.mapError(() => new ContainerError({ reason: "storage" })),
    );
  const present = Effect.fn("ManagedContainers.present")(function* (row: StoredResource) {
    const specification = decodeSpecification(row.specification);
    if (Option.isNone(specification)) return yield* new ContainerError({ reason: "storage" });
    return {
      resourceId: row.id,
      workspaceId: row.workspaceId,
      threadId: row.threadId,
      engineId: row.engineId,
      containerId: row.containerId,
      name: row.name,
      image: specification.value.image,
      phase: row.phase,
      generation: row.generation,
      retained: Boolean(row.retained),
      references: yield* references(row.id),
      failure: row.failure,
    } satisfies ManagedContainer;
  });
  const threadContext = Effect.fn("ManagedContainers.threadContext")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => new ContainerError({ reason: "unavailable" })));
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null)
      return yield* new ContainerError({ reason: "not-found" });
    const project = yield* projects
      .getShell(thread.projectId)
      .pipe(Effect.mapError(() => new ContainerError({ reason: "unavailable" })));
    if (Option.isNone(project)) return yield* new ContainerError({ reason: "not-found" });
    const root = yield* fs
      .realPath(thread.worktreePath ?? project.value.workspaceRoot)
      .pipe(Effect.mapError(() => new ContainerError({ reason: "unavailable" })));
    if (path.parse(root).root === root || /[,\r\n]/.test(root))
      return yield* new ContainerError({ reason: "ownership" });
    yield* workspaces
      .assertContains(root)
      .pipe(Effect.mapError(() => new ContainerError({ reason: "ownership" })));
    return { thread, root };
  });
  const update = Effect.fn("ManagedContainers.update")(function* (
    row: StoredResource,
    phase: ManagedContainer["phase"],
    failure: string | null,
    containerId = row.containerId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const changed = yield* sql<{
      readonly id: string;
    }>`UPDATE execution_containers SET phase=${phase},failure=${failure},container_id=${containerId},generation=generation+1,updated_at=${now} WHERE id=${row.id} AND generation=${row.generation} RETURNING id`.pipe(
      Effect.mapError(() => new ContainerError({ reason: "storage" })),
    );
    if (!changed.length) return yield* new ContainerError({ reason: "revision" });
    return (yield* read(row.id))[0]!;
  });
  const owner = (row: StoredResource): ManagedContainerDriver.ContainerOwnership => ({
    engineId: row.engineId,
    workspaceId: row.workspaceId,
    resourceId: row.id,
    name: row.name,
  });
  const completeCreate = Effect.fn("ManagedContainers.completeCreate")(function* (
    row: StoredResource,
  ) {
    const specification = decodeSpecification(row.specification);
    if (Option.isNone(specification)) return yield* new ContainerError({ reason: "storage" });
    const context = yield* threadContext(row.threadId);
    if (context.root !== row.root || context.thread.projectId !== row.projectId)
      return yield* new ContainerError({ reason: "ownership" });
    const result = yield* driver
      .ensureCreated(owner(row), specification.value, row.root)
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* update(row, "failed", result.failure.reason);
      return yield* result.failure;
    }
    return yield* update(row, "ready", null, result.success);
  });
  return ManagedContainers.of({
    list: Effect.fn("ManagedContainers.list")(function* (threadId) {
      const rows = yield* read(undefined, threadId);
      return {
        items: yield* Effect.forEach(rows.slice(0, 1000), present),
        complete: rows.length <= 1000,
      };
    }),
    create: Effect.fn("ManagedContainers.create")(function (input) {
      return gate.withPermits(1)(
        Effect.gen(function* () {
          const context = yield* threadContext(input.threadId);
          const specification = encodeSpecification({
            threadId: input.threadId,
            requestId: input.requestId,
            image: input.image,
            command: input.command,
            mountWorkspace: input.mountWorkspace,
            ports: [...new Set(input.ports)].sort((a, b) => a - b),
          });
          const now = yield* Clock.currentTimeMillis;
          const workspaceId = yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError(() => new ContainerError({ reason: "storage" })));
          yield* sql`INSERT INTO execution_workspaces(id,thread_id,project_id,root,created_at) VALUES(${workspaceId},${input.threadId},${context.thread.projectId},${context.root},${now}) ON CONFLICT(thread_id) DO NOTHING`.pipe(
            Effect.mapError(() => new ContainerError({ reason: "storage" })),
          );
          const stored = yield* sql<{
            readonly id: string;
            readonly root: string;
            readonly projectId: string;
          }>`SELECT id,root,project_id AS "projectId" FROM execution_workspaces WHERE thread_id=${input.threadId}`.pipe(
            Effect.mapError(() => new ContainerError({ reason: "storage" })),
          );
          const workspace = stored[0];
          if (
            !workspace ||
            workspace.root !== context.root ||
            workspace.projectId !== context.thread.projectId
          )
            return yield* new ContainerError({ reason: "ownership" });
          const existingIds = yield* sql<{
            readonly id: string;
          }>`SELECT id FROM execution_containers WHERE workspace_id=${workspace.id} AND request_id=${input.requestId}`.pipe(
            Effect.mapError(() => new ContainerError({ reason: "storage" })),
          );
          const existing = existingIds[0] ? (yield* read(existingIds[0].id))[0] : undefined;
          if (existing) {
            if (existing.specification !== specification)
              return yield* new ContainerError({ reason: "revision" });
            if (existing.phase === "released" || existing.phase === "releasing")
              return yield* new ContainerError({ reason: "revision" });
            return yield* present(
              existing.phase === "ready" ? existing : yield* completeCreate(existing),
            );
          }
          const engineId = yield* driver.engineId;
          const id = yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError(() => new ContainerError({ reason: "storage" })));
          const name = `t3-${id}`;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO execution_containers(id,workspace_id,request_id,engine_id,name,specification_json,phase,updated_at) VALUES(${id},${workspace.id},${input.requestId},${engineId},${name},${specification},'pending',${now})`;
                yield* sql`INSERT INTO execution_container_references(resource_id,thread_id) VALUES(${id},${input.threadId})`;
              }),
            )
            .pipe(Effect.mapError(() => new ContainerError({ reason: "storage" })));
          return yield* present(yield* completeCreate((yield* read(id))[0]!));
        }),
      );
    }),
    command: Effect.fn("ManagedContainers.command")(function (input) {
      return gate.withPermits(1)(
        Effect.gen(function* () {
          let row = (yield* read(input.resourceId))[0];
          if (!row) return yield* new ContainerError({ reason: "not-found" });
          if (row.generation !== input.generation)
            return yield* new ContainerError({ reason: "revision" });
          const refs = yield* references(row.id);
          if (!refs.includes(input.threadId))
            return yield* new ContainerError({ reason: "ownership" });
          if (row.phase === "released") return yield* present(row);
          if (input.operation === "share") {
            if (
              !input.referenceThreadId ||
              row.threadId !== input.threadId ||
              row.phase !== "ready"
            )
              return yield* new ContainerError({ reason: "ownership" });
            const destination = yield* threadContext(input.referenceThreadId);
            if (destination.thread.projectId !== row.projectId)
              return yield* new ContainerError({ reason: "ownership" });
            const current = row;
            const changed = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const updated = yield* update(current, current.phase, current.failure);
                  yield* sql`INSERT INTO execution_container_references(resource_id,thread_id) VALUES(${current.id},${input.referenceThreadId!}) ON CONFLICT DO NOTHING`;
                  return updated;
                }),
              )
              .pipe(Effect.mapError(() => new ContainerError({ reason: "storage" })));
            return yield* present(changed);
          }
          if (input.operation === "retain" || input.operation === "unretain") {
            if (row.threadId !== input.threadId)
              return yield* new ContainerError({ reason: "ownership" });
            const current = row;
            const changed = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* update(current, current.phase, current.failure);
                  yield* sql`UPDATE execution_containers SET retained=${input.operation === "retain" ? 1 : 0} WHERE id=${current.id}`;
                  return (yield* read(current.id))[0]!;
                }),
              )
              .pipe(Effect.mapError(() => new ContainerError({ reason: "storage" })));
            return yield* present(changed);
          }
          if (input.operation === "release" && refs.length > 1) {
            if (row.threadId === input.threadId)
              return yield* new ContainerError({ reason: "ownership" });
            const current = row;
            const changed = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const updated = yield* update(current, current.phase, current.failure);
                  yield* sql`DELETE FROM execution_container_references WHERE resource_id=${current.id} AND thread_id=${input.threadId}`;
                  return updated;
                }),
              )
              .pipe(Effect.mapError(() => new ContainerError({ reason: "storage" })));
            return yield* present(changed);
          }
          if (refs.length !== 1) return yield* new ContainerError({ reason: "ownership" });
          if (input.operation === "retry") {
            if (row.phase !== "pending" && row.phase !== "failed")
              return yield* new ContainerError({ reason: "revision" });
            return yield* present(yield* completeCreate(row));
          }
          if (
            row.phase !== "ready" &&
            !(input.operation === "release" && row.phase === "releasing")
          )
            return yield* new ContainerError({ reason: "revision" });
          if (input.operation === "release" && row.retained)
            return yield* new ContainerError({ reason: "retained" });
          if (!row.containerId) return yield* new ContainerError({ reason: "unavailable" });
          if (input.operation === "release") row = yield* update(row, "releasing", null);
          const current = row;
          const operation = input.operation;
          const result = yield* driver
            .control(owner(current), current.containerId!, operation)
            .pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* update(row, row.phase, result.failure.reason);
            return yield* result.failure;
          }
          return yield* present(
            yield* update(row, input.operation === "release" ? "released" : "ready", null),
          );
        }),
      );
    }),
  });
});

export const layer = Layer.effect(ManagedContainers, make);
