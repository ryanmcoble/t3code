import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ContainerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ManagedContainerDriver from "./ManagedContainerDriver.ts";
import * as ManagedContainers from "./ManagedContainers.ts";

const threadId = ThreadId.make("thread-a");
const peerId = ThreadId.make("thread-b");
const projectId = ProjectId.make("project-a");
const image = `sha256:${"b".repeat(64)}`;
const input = {
  threadId,
  requestId: "request-a",
  image,
  command: ["sleep", "600"],
  mountWorkspace: false,
  ports: [],
};
const containerId = "a".repeat(64);
function thread(id: ThreadId, root: string): OrchestrationV2ThreadShell {
  return {
    id,
    projectId,
    title: "Sample",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sample" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: root,
    branch: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    deletedAt: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  };
}
const harness = Effect.fn("ManagedContainers.testHarness")(function* (
  driver: ManagedContainerDriver.ManagedContainerDriver["Service"],
  workspaceRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = workspaceRoot ?? (yield* fs.realPath(yield* fs.makeTempDirectoryScoped()));
  return ManagedContainers.layer.pipe(
    Layer.provide(Layer.succeed(ManagedContainerDriver.ManagedContainerDriver, driver)),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (id) => Effect.succeed(thread(id, root)),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Sample",
            workspaceRoot: root,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-11-11T00:00:00Z",
            updatedAt: "2026-11-11T00:00:00Z",
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
    ),
    Layer.fresh,
  );
});

it.effect(
  "persists intent before creation and recovers the same resource after a failed acknowledgement and service restart",
  () => {
    let first = true;
    let durableId = "";
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const driver: ManagedContainerDriver.ManagedContainerDriver["Service"] = {
        engineId: Effect.succeed("engine-a"),
        ensureCreated: (owner) =>
          Effect.gen(function* () {
            const intents = yield* sql<{
              readonly phase: string;
            }>`SELECT phase FROM execution_containers WHERE id=${owner.resourceId}`.pipe(
              Effect.orDie,
            );
            assert.equal(intents[0]?.phase, first ? "pending" : "failed");
            if (first) {
              first = false;
              durableId = owner.resourceId;
              return yield* new ContainerError({ reason: "unavailable" });
            }
            assert.equal(owner.resourceId, durableId);
            return containerId;
          }),
        control: () => Effect.die("No control expected"),
      };
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const firstLayer = yield* harness(driver, root);
      yield* Effect.gen(function* () {
        const resources = yield* ManagedContainers.ManagedContainers;
        const result = yield* resources.create(input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal((yield* resources.list(threadId)).items[0]?.phase, "failed");
      }).pipe(Effect.provide(firstLayer));
      const secondLayer = yield* harness(driver, root);
      yield* Effect.gen(function* () {
        const resources = yield* ManagedContainers.ManagedContainers;
        const resource = yield* resources.create(input);
        assert.equal(resource.resourceId, durableId);
        assert.equal(resource.containerId, containerId);
        assert.equal(resource.phase, "ready");
      }).pipe(Effect.provide(secondLayer));
    }).pipe(
      Effect.scoped,
      Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
    );
  },
);

it.effect(
  "protects retained/shared resources, rejects stale actions and releases only the exact owned container",
  () => {
    const actions: string[] = [];
    return Effect.gen(function* () {
      const layer = yield* harness({
        engineId: Effect.succeed("engine-a"),
        ensureCreated: () => Effect.succeed(containerId),
        control: (owner, id, action) =>
          Effect.sync(() => {
            assert.equal(id, containerId);
            assert.isNotEmpty(owner.resourceId);
            actions.push(action);
          }),
      });
      yield* Effect.gen(function* () {
        const resources = yield* ManagedContainers.ManagedContainers;
        let resource = yield* resources.create(input);
        assert.equal((yield* resources.create(input)).resourceId, resource.resourceId);
        const staleGeneration = resource.generation;
        resource = yield* resources.command({
          resourceId: resource.resourceId,
          threadId,
          generation: resource.generation,
          operation: "retain",
        });
        const retained = yield* resources
          .command({
            resourceId: resource.resourceId,
            threadId,
            generation: resource.generation,
            operation: "release",
          })
          .pipe(Effect.result);
        assert.equal(retained._tag, "Failure");
        if (retained._tag === "Failure") assert.equal(retained.failure.reason, "retained");
        const stale = yield* resources
          .command({
            resourceId: resource.resourceId,
            threadId,
            generation: staleGeneration,
            operation: "stop",
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        resource = yield* resources.command({
          resourceId: resource.resourceId,
          threadId,
          generation: resource.generation,
          operation: "unretain",
        });
        resource = yield* resources.command({
          resourceId: resource.resourceId,
          threadId,
          generation: resource.generation,
          operation: "share",
          referenceThreadId: peerId,
        });
        assert.deepEqual(resource.references, [threadId, peerId]);
        const shared = yield* resources
          .command({
            resourceId: resource.resourceId,
            threadId,
            generation: resource.generation,
            operation: "release",
          })
          .pipe(Effect.result);
        assert.equal(shared._tag, "Failure");
        assert.deepEqual(actions, []);
        resource = yield* resources.command({
          resourceId: resource.resourceId,
          threadId: peerId,
          generation: resource.generation,
          operation: "release",
        });
        assert.deepEqual(actions, []);
        resource = yield* resources.command({
          resourceId: resource.resourceId,
          threadId,
          generation: resource.generation,
          operation: "release",
        });
        assert.equal(resource.phase, "released");
        assert.deepEqual(actions, ["release"]);
        const replay = yield* resources.command({
          resourceId: resource.resourceId,
          threadId,
          generation: resource.generation,
          operation: "release",
        });
        assert.equal(replay.phase, "released");
        assert.deepEqual(actions, ["release"]);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
    );
  },
);
