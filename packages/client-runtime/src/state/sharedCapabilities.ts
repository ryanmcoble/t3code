import {
  WS_METHODS,
  SharedMemoryError,
  type EnvironmentId,
  type MemoryRemoteBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeCommand,
} from "./runtime.ts";

export function createSharedCapabilityAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const memoryState = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "memory:state",
    tag: WS_METHODS.memoryState,
    staleTimeMs: 0,
  });
  const memoryQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "memory:query",
    tag: WS_METHODS.memoryQuery,
    staleTimeMs: 0,
  });
  const computerState = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "computer:state",
    tag: WS_METHODS.computerUseState,
    staleTimeMs: 0,
  });
  const memoryCommand = createEnvironmentRpcCommand(runtime, {
    label: "memory:command",
    tag: WS_METHODS.memoryCommand,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(memoryState({ environmentId, input: {} }))),
  });
  const memoryGrant = createEnvironmentRpcCommand(runtime, {
    label: "memory:grant",
    tag: WS_METHODS.memoryGrant,
  });
  const enroll = createRuntimeCommand(runtime, {
    label: "memory:enroll",
    execute: Effect.fn("Memory.enroll")(function* (
      input: {
        readonly ownerId: EnvironmentId;
        readonly destinationId: EnvironmentId;
        readonly binding: MemoryRemoteBinding;
      },
      registry,
    ) {
      const result = yield* Effect.promise(() =>
        memoryGrant.run(registry, {
          environmentId: input.ownerId,
          input: {
            scopeId: input.binding.scopeId,
            destinationEnvironmentId: input.destinationId,
            access: input.binding.access,
            revoke: false,
          },
        }),
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      if (!result.value.token) return yield* new SharedMemoryError({ reason: "denied" });
      const enrolled = yield* Effect.promise(() =>
        memoryCommand.run(registry, {
          environmentId: input.destinationId,
          input: {
            operation: "connect",
            binding: input.binding,
            token: result.value.token!,
          },
        }),
      );
      if (enrolled._tag === "Failure") return yield* Effect.failCause(enrolled.cause);
    }),
  });
  return {
    memoryState,
    memoryQuery,
    memoryCommand,
    memoryGrant,
    enroll,
    computerState,
    memoryExport: createEnvironmentRpcCommand(runtime, {
      label: "memory:export",
      tag: WS_METHODS.memoryExport,
    }),
    computerCommand: createEnvironmentRpcCommand(runtime, {
      label: "computer:command",
      tag: WS_METHODS.computerUseCommand,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(computerState({ environmentId, input: {} }))),
    }),
  };
}
