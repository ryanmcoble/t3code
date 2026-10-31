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
  return {
    kind: "agent" as const,
    projectId: caller.projectId,
    providerInstanceId: scope.thread.providerInstanceId,
    threadId: scope.thread.threadId,
  };
});
export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  t3_memory_scopes: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const caller = yield* actor;
      const state = yield* (yield* SharedMemory.SharedMemory).state;
      const allowed = (scope: {
        readonly projectIds: ReadonlyArray<string>;
        readonly providerInstanceIds: ReadonlyArray<string>;
      }) =>
        scope.projectIds.includes(caller.projectId) &&
        scope.providerInstanceIds.includes(caller.providerInstanceId);
      return [
        ...state.scopes.filter(allowed).map(({ id, name, kind }) => ({ id, name, kind })),
        ...state.bindings
          .filter(allowed)
          .map(({ scopeId, name }) => ({ id: scopeId, name, kind: "shared" })),
      ];
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
