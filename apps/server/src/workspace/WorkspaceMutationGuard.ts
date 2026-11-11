import { isLiveSubagentShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { withWorkspaceLeases, workspacePathsOverlap } from "./workspaceLease.ts";

export class WorkspaceBusyError extends Schema.TaggedError<WorkspaceBusyError>()(
  "WorkspaceBusyError",
  {
    reason: Schema.Literals(["active", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "active"
      ? "Folder updates are waiting for active threads and terminal commands to finish."
      : "Folder updates are paused because workspace activity could not be verified.";
  }
}

export class WorkspaceMutationGuard extends Context.Service<
  WorkspaceMutationGuard,
  {
    readonly withIdle: <A, E, R>(
      cwds: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorkspaceBusyError, R>;
  }
>()("t3/workspace/WorkspaceMutationGuard") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = Effect.fn("WorkspaceMutationGuard.canonical")(function* (root: string) {
    return yield* fs.realPath(root).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? fs
                .realPath(path.dirname(root))
                .pipe(Effect.map((parent) => path.join(parent, path.basename(root))))
            : Effect.fail(cause),
      }),
      Effect.mapError((cause) => new WorkspaceBusyError({ reason: "unavailable", cause })),
    );
  });
  const assertIdle = Effect.fn("WorkspaceMutationGuard.assertIdle")(function* (
    cwds: ReadonlyArray<string>,
  ) {
    const snapshot = yield* projections
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => new WorkspaceBusyError({ reason: "unavailable", cause })));
    const now = yield* Clock.currentTimeMillis;
    const threads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) => isLiveSubagentShell(thread) || threadHasQueuedTurnStart(thread, now),
    );
    const roots = new Map<string, string>();
    for (const thread of threads) {
      let projectRoot = roots.get(thread.projectId);
      if (!projectRoot) {
        const project = yield* projects
          .getShell(thread.projectId)
          .pipe(
            Effect.mapError((cause) => new WorkspaceBusyError({ reason: "unavailable", cause })),
          );
        if (Option.isNone(project)) return yield* new WorkspaceBusyError({ reason: "unavailable" });
        projectRoot = yield* canonical(path.resolve(project.value.workspaceRoot));
        roots.set(thread.projectId, projectRoot);
      }
      const worktree = thread.worktreePath
        ? yield* canonical(path.resolve(thread.worktreePath))
        : null;
      if (
        cwds.some(
          (cwd) =>
            workspacePathsOverlap(cwd, projectRoot) ||
            (worktree !== null && workspacePathsOverlap(cwd, worktree)),
        )
      )
        return yield* new WorkspaceBusyError({ reason: "active" });
    }
    if (yield* terminals.workspaceBusy(cwds))
      return yield* new WorkspaceBusyError({ reason: "active" });
  });
  return WorkspaceMutationGuard.of({
    withIdle: Effect.fn("WorkspaceMutationGuard.withIdle")(function* <A, E, R>(
      cwds: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ) {
      const roots = cwds.map((root) => path.resolve(root));
      const aliases = yield* Effect.forEach(roots, canonical);
      const leased = [...new Set([...roots, ...aliases])];
      return yield* withWorkspaceLeases(leased, assertIdle(leased).pipe(Effect.andThen(effect)));
    }),
  });
});

export const layer = Layer.effect(WorkspaceMutationGuard, make);
