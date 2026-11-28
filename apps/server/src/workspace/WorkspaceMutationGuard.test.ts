import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Guard from "./WorkspaceMutationGuard.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

const projectId = ProjectId.make("sample");
const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("sample-thread");
const thread = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: threadId,
  projectId,
  title: "Sample",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: null,
  linkedPullRequest: null,
  status: "idle",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: null,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  latestUserMessageAt: null,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  ...overrides,
});

it.effect(
  "guards active, queued and background work across nested roots, preserves idle workspaces and rechecks after waiting",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-guard-" });
      const root = yield* fs.realPath(temporary);
      yield* fs.makeDirectory(`${root}/nested`);
      yield* fs.makeDirectory(`${root}/other`);
      let current = thread();
      let terminalBusy = false;
      let missingProject = false;
      let writes = 0;
      const layer = Guard.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.sync(() => ({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [current],
              })),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            getShell: () =>
              Effect.sync(() =>
                missingProject
                  ? Option.none()
                  : Option.some({
                      id: projectId,
                      title: "Project",
                      workspaceRoot: root,
                      scripts: [],
                      defaultModelSelection: null,
                      createdAt: "2026-11-11T00:00:00Z",
                      updatedAt: "2026-11-11T00:00:00Z",
                    }),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(TerminalManager.TerminalManager)({
            workspaceBusy: () => Effect.sync(() => terminalBusy),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const guard = yield* Guard.WorkspaceMutationGuard;
        const write = guard.withIdle(
          [`${root}/nested`],
          Effect.sync(() => {
            writes++;
          }),
        );
        yield* write;
        assert.equal(writes, 1);
        const changes: ReadonlyArray<Partial<OrchestrationV2ThreadShell>> = [
          { status: "running" as const },
          { activityRunStatus: "waiting" as const },
          { pendingBackgroundTasks: [{ kind: "command", taskId: "build" }] },
          { latestUserMessageAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis) },
        ];
        for (const change of changes) {
          current = thread(change);
          const result = yield* write.pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure.reason, "active");
          assert.equal(writes, 1);
        }
        current = thread({ status: "running", worktreePath: `${root}/other` });
        const unrelated = yield* fs.makeTempDirectoryScoped({ prefix: "t3-unrelated-guard-" });
        yield* guard.withIdle([unrelated], Effect.void);
        missingProject = true;
        const missing = yield* write.pipe(Effect.result);
        if (missing._tag !== "Failure")
          return assert.fail("Expected missing activity context to block");
        assert.equal(missing.failure.reason, "unavailable");
        missingProject = false;
        current = thread();
        terminalBusy = true;
        assert.equal((yield* write.pipe(Effect.result))._tag, "Failure");
        terminalBusy = false;
        const release = yield* Deferred.make<void>();
        const holder = yield* withWorkspaceLease(root, Deferred.await(release)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const waiting = yield* write.pipe(
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        );
        current = thread({ status: "running" });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const blocked = yield* Fiber.join(waiting);
        assert.equal(blocked._tag, "Failure");
        assert.equal(writes, 1);
        current = thread();
        yield* guard.withIdle(
          [`${root}/new-folder`],
          Effect.sync(() => {
            writes++;
          }),
        );
        assert.equal(writes, 2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
