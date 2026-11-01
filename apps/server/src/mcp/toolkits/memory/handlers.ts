import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as Option from "effect/Option";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SharedMemory from "../../../memory/SharedMemory.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const actor = Effect.gen(function* () {
  const context = yield* loadCaller();
  const scope = yield* McpInvocationContext.requireThreadScope(context.scope, "Shared memory");
  const caller = context.caller!;
  const project = yield* (yield* ProjectStore.ProjectStoreV2).getShell(caller.projectId).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Memory project unavailable.",
        }),
    ),
  );
  const root = Option.isSome(project) ? project.value.workspaceRoot : undefined;
  return {
    kind: "agent" as const,
    ...(root === undefined ? {} : { cwd: caller.worktreePath ?? root, projectRoot: root }),
    projectId: caller.projectId,
    providerInstanceId: scope.thread.providerInstanceId,
    threadId: scope.thread.threadId,
  };
});
export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  t3_memory_forget: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      if ((yield* loadCaller()).limits.interactionMode === "plan")
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Shared memory cannot be changed in planning mode.",
        });
      yield* (yield* SharedMemory.SharedMemory).forget(input, yield* actor);
    }),
  ),
  t3_memory_scopes: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const caller = yield* actor;
      return (yield* (yield* SharedMemory.SharedMemory).available(caller)).map(
        ({ id, name, kind }) => ({ id, name, kind }),
      );
    }),
  ),
  t3_memory_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* SharedMemory.SharedMemory).query(input, yield* actor);
    }),
  ),
  t3_memory_remember: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      if ((yield* loadCaller()).limits.interactionMode === "plan")
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Shared memory cannot be changed in planning mode.",
        });
      return yield* (yield* SharedMemory.SharedMemory).write(input, yield* actor);
    }),
  ),
});
