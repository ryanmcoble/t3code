import type { MemoryTurnContext, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SharedMemory from "./SharedMemory.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export class MemoryTurnObserver extends Context.Reference<{
  readonly recall: (input: {
    readonly id: string;
    readonly context: MemoryTurnContext;
    readonly text: string;
    readonly contextKey?: string;
  }) => Effect.Effect<string>;
  readonly delivered: (id: string) => Effect.Effect<void>;
  readonly complete: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void>;
}>("t3/memory/MemoryTurnObserver", {
  defaultValue: () => ({
    recall: () => Effect.succeed(""),
    delivered: () => Effect.void,
    complete: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  MemoryTurnObserver,
  Effect.gen(function* () {
    const memory = yield* SharedMemory.SharedMemory;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    return {
      recall: Effect.fn("MemoryTurnObserver.recall")(function (input) {
        return memory.recall(input).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.logWarning("Memory recall unavailable").pipe(Effect.as(""))),
        );
      }),
      delivered: Effect.fn("MemoryTurnObserver.delivered")((id) =>
        memory
          .acknowledgeRecall(id)
          .pipe(Effect.catch(() => Effect.logWarning("Memory receipt could not be acknowledged"))),
      ),
      complete: Effect.fn("MemoryTurnObserver.complete")(
        function* ({ threadId, runId }) {
          const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
          const run = projection.runs.find((value) => value.id === runId);
          if (!run || run.status !== "completed") return;
          const message = yield* projections.getRunMessage(threadId, runId);
          const project = yield* projects.getShell(projection.thread.projectId);
          if (!message || Option.isNone(project) || projection.thread.interactionMode === "plan")
            return;
          yield* memory.capture({
            id: runId,
            text: message.text,
            context: {
              readOnly: false,
              threadId,
              projectId: projection.thread.projectId,
              providerInstanceId: run.providerInstanceId,
              cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
              projectRoot: project.value.workspaceRoot,
            },
          });
        },
        Effect.catch(() => Effect.logWarning("Memory capture could not be queued")),
      ),
    };
  }),
);
