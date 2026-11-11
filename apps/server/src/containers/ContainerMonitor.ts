import {
  ContainerError,
  type ContainerAssociationCommand,
  type ContainerLogsInput,
  type ContainerRecord,
  type ContainerSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as DockerAdapter from "./DockerAdapter.ts";
import { associateContainer, partitionContainers } from "./DockerModel.ts";

export class ContainerMonitor extends Context.Service<
  ContainerMonitor,
  {
    readonly refresh: Effect.Effect<ContainerSnapshot>;
    readonly subscribe: Effect.Effect<
      { readonly latest: ContainerSnapshot; readonly changes: Stream.Stream<ContainerSnapshot> },
      never,
      Scope.Scope
    >;
    readonly associate: (
      input: typeof ContainerAssociationCommand.Type,
    ) => Effect.Effect<void, ContainerError>;
    readonly logs: (
      input: typeof ContainerLogsInput.Type,
    ) => Effect.Effect<{ readonly text: string; readonly truncated: boolean }, ContainerError>;
  }
>()("t3/containers/ContainerMonitor") {}

const failureMessage = {
  "cli-missing": "Docker CLI is not installed or is outside this environment service's PATH.",
  "engine-unavailable":
    "Docker is unavailable on this environment. Start its local engine and refresh.",
  "permission-denied": "This environment service cannot access the Docker socket.",
  unsupported:
    "Only a local Docker Engine/Desktop on macOS or Linux is supported. Remote SSH/TCP contexts are not treated as this environment.",
} as const;

const make = Effect.gen(function* () {
  const adapter = yield* DockerAdapter.DockerAdapter;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gate = yield* Semaphore.make(1);
  const liveGate = yield* Semaphore.make(1);
  const updates = yield* PubSub.sliding<ContainerSnapshot>(4);
  const cached = yield* Ref.make<ContainerSnapshot>({
    sampledAt: 0,
    engineId: null,
    engineName: null,
    status: "starting",
    message: "Checking this environment's Docker engine…",
    complete: false,
    stale: true,
    containers: [],
    counts: partitionContainers([]),
  });
  const live = yield* Ref.make<{ readonly count: number; readonly scope: Scope.Closeable | null }>({
    count: 0,
    scope: null,
  });

  const decorate = Effect.fn("ContainerMonitor.decorate")(function* (
    engineId: string,
    containers: ReadonlyArray<ContainerRecord>,
  ) {
    const projectShells = yield* projects.listShells();
    const threadRoots = yield* sql<{
      readonly folder: string;
    }>`SELECT DISTINCT json_extract(payload_json,'$.worktreePath') AS folder FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json,'$.worktreePath') IS NOT NULL`.pipe(
      NodeSqliteClient.readOnly,
    );
    const links = yield* sql<{
      readonly containerId: string;
      readonly folder: string;
      readonly rule: "include" | "exclude";
    }>`SELECT container_id AS "containerId",folder,rule FROM container_associations WHERE engine_id=${engineId}`.pipe(
      NodeSqliteClient.readOnly,
    );
    const resolved = new Map<string, string | null>();
    const normalize = Effect.fnUntraced(function* (value: string) {
      if (!path.isAbsolute(value)) return null;
      if (resolved.has(value)) return resolved.get(value)!;
      const real = yield* fs.realPath(value).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.succeed(error.reason._tag === "NotFound" ? path.normalize(value) : null),
        }),
      );
      const root = real !== null && path.parse(real).root !== real ? real : null;
      resolved.set(value, root);
      return root;
    });
    const roots = [
      ...new Set(
        (yield* Effect.forEach(
          [
            ...projectShells.map((project) => project.workspaceRoot),
            ...threadRoots.map((entry) => entry.folder),
          ],
          normalize,
        )).filter((root): root is string => root !== null),
      ),
    ];
    return yield* Effect.forEach(containers, (container) =>
      Effect.gen(function* () {
        const composePaths = (yield* Effect.forEach(container.composePaths, normalize)).filter(
          (entry): entry is string => entry !== null,
        );
        const bindSources = (yield* Effect.forEach(container.bindSources, normalize)).filter(
          (entry): entry is string => entry !== null,
        );
        const matching = links.filter((link) => link.containerId === container.id);
        return {
          ...container,
          associations: associateContainer(
            { composePaths, bindSources },
            roots,
            matching.filter((link) => link.rule === "include").map((link) => link.folder),
            matching.filter((link) => link.rule === "exclude").map((link) => link.folder),
          ),
        };
      }),
    );
  });

  const publish = (snapshot: ContainerSnapshot) =>
    Ref.set(cached, snapshot).pipe(
      Effect.andThen(PubSub.publish(updates, snapshot)),
      Effect.as(snapshot),
    );
  const refresh = gate.withPermits(1)(
    Effect.gen(function* () {
      const previous = yield* Ref.get(cached);
      const result = yield* adapter.inventory.pipe(Effect.result);
      if (result._tag === "Failure")
        return yield* publish({
          ...previous,
          status: result.failure.status,
          message: failureMessage[result.failure.status],
          complete: false,
          stale: true,
        });
      const inventory = result.success;
      const decorated = yield* decorate(inventory.engineId, inventory.containers).pipe(
        Effect.result,
      );
      const containers = decorated._tag === "Success" ? decorated.success : inventory.containers;
      const complete = inventory.complete && decorated._tag === "Success";
      return yield* publish({
        ...inventory,
        containers,
        complete,
        stale: false,
        status: complete ? "ready" : "partial",
        message:
          decorated._tag === "Failure"
            ? "Inventory is current, but folder associations could not be loaded."
            : inventory.message,
        sampledAt: yield* Clock.currentTimeMillis,
        counts: partitionContainers(containers),
      });
    }),
  );
  const acquireLive = liveGate.withPermits(1)(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = yield* Ref.get(live);
        if (current.count > 0) {
          yield* Ref.set(live, { ...current, count: current.count + 1 });
          return;
        }
        const scope = yield* Scope.make();
        yield* refresh.pipe(
          Effect.andThen(Effect.sleep("5 seconds")),
          Effect.forever,
          Effect.interruptible,
          Effect.forkIn(scope),
        );
        yield* Ref.set(live, { count: 1, scope });
      }),
    ),
  );
  const releaseLive = liveGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(live);
      if (current.count > 1) {
        yield* Ref.set(live, { ...current, count: current.count - 1 });
        return;
      }
      yield* Ref.set(live, { count: 0, scope: null });
      if (current.scope) yield* Scope.close(current.scope, Exit.void);
    }),
  );

  yield* Effect.addFinalizer(() =>
    liveGate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(live);
        yield* Ref.set(live, { count: 0, scope: null });
        if (current.scope) yield* Scope.close(current.scope, Exit.void);
        yield* PubSub.shutdown(updates);
      }),
    ),
  );
  return ContainerMonitor.of({
    refresh,
    subscribe: subscribeBeforeSnapshot(
      updates,
      Effect.acquireRelease(acquireLive, () => releaseLive).pipe(Effect.andThen(Ref.get(cached))),
      gate,
    ),
    logs: Effect.fn("ContainerMonitor.logs")((input) => adapter.logs(input, input.lines)),
    associate: Effect.fn("ContainerMonitor.associate")(function* (input) {
      if (input.operation !== "remove") {
        const snapshot = yield* refresh;
        if (snapshot.stale) return yield* new ContainerError({ reason: "unavailable" });
        if (snapshot.engineId !== input.engineId)
          return yield* new ContainerError({ reason: "engine-changed" });
        if (!snapshot.containers.some((container) => container.id === input.containerId))
          return yield* new ContainerError({ reason: "not-found" });
        yield* workspaces
          .assertContains(input.folder)
          .pipe(Effect.mapError(() => new ContainerError({ reason: "permission-denied" })));
      }
      const folder =
        input.operation === "remove"
          ? input.folder
          : yield* fs
              .realPath(input.folder)
              .pipe(Effect.mapError(() => new ContainerError({ reason: "unavailable" })));
      yield* gate
        .withPermits(1)(
          Effect.gen(function* () {
            if (input.operation === "remove")
              yield* sql`DELETE FROM container_associations WHERE engine_id=${input.engineId} AND container_id=${input.containerId} AND folder=${folder}`;
            else
              yield* sql`INSERT INTO container_associations(engine_id,container_id,folder,rule) VALUES(${input.engineId},${input.containerId},${folder},${input.operation}) ON CONFLICT(engine_id,container_id,folder) DO UPDATE SET rule=excluded.rule`;
            const snapshot = yield* Ref.get(cached);
            if (snapshot.engineId) {
              const containers = yield* decorate(snapshot.engineId, snapshot.containers);
              yield* publish({ ...snapshot, containers });
            }
          }),
        )
        .pipe(Effect.mapError(() => new ContainerError({ reason: "storage" })));
    }),
  });
});

export const layer = Layer.effect(ContainerMonitor, make);
