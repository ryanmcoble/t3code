import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SharedMemory from "./SharedMemory.ts";
import * as MemoryTurnObserver from "./MemoryTurnObserver.ts";

it.effect(
  "captures the persisted user message omitted from a completed run's recovery projection",
  () => {
    const threadId = ThreadId.make("completed-memory-thread");
    const projectId = ProjectId.make("memory-project");
    const runId = RunId.make("completed-memory-run");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const messageId = MessageId.make("memory-user-message");
    const captured: Array<Parameters<SharedMemory.SharedMemory["Service"]["capture"]>[0]> = [];
    const projection: ProjectionStore.ProjectionRuntimeRecoveryState = {
      thread: {
        id: threadId,
        projectId,
        interactionMode: "default",
        worktreePath: null,
      } as ProjectionStore.ProjectionRuntimeRecoveryState["thread"],
      runs: [
        {
          id: runId,
          status: "completed",
          providerInstanceId,
          userMessageId: messageId,
        } as ProjectionStore.ProjectionRuntimeRecoveryState["runs"][number],
      ],
      messages: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      turnItems: [],
    };
    const layer = MemoryTurnObserver.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getRunMessage: () =>
              Effect.succeed({
                id: messageId,
                role: "user",
                text: "I prefer concise status updates.",
              } as OrchestrationV2ConversationMessage),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            getShell: () =>
              Effect.succeedSome({
                id: projectId,
                workspaceRoot: "/repo",
              } as OrchestrationProjectShell),
          }),
          Layer.mock(SharedMemory.SharedMemory)({
            capture: (input) =>
              Effect.sync(() => {
                captured.push(input);
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const observer = yield* MemoryTurnObserver.MemoryTurnObserver;
      yield* observer.complete({ threadId, runId });
      assert.deepEqual(captured, [
        {
          id: runId,
          text: "I prefer concise status updates.",
          context: {
            readOnly: false,
            threadId,
            projectId,
            providerInstanceId,
            cwd: "/repo",
            projectRoot: "/repo",
          },
        },
      ]);
    }).pipe(Effect.provide(layer));
  },
);
