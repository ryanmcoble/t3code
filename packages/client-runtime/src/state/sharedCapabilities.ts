export {
  groupContainers,
  containerRuleAvailability,
  resolveContainerFolders,
  containerCountLabel,
  containerPanelSummary,
  containerMetricsLabel,
  managedContainerStatus,
  type ContainerFilter,
} from "../containerPresentation.ts";
export { memoryRulesFromDraft, memoryRulesDraftError } from "../memoryRules.ts";
export {
  sharedProjectMappingStatus,
  sharedProjectMemberLabel,
} from "../sharedProjectPresentation.ts";
import {
  WS_METHODS,
  SharedProjectError,
  SharedMemoryError,
  type EnvironmentId,
  type ThreadId,
  type MemoryRemoteBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcSubscriptionAtomFamily,
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
  const managedContainers = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "containers:managed",
    tag: WS_METHODS.containersManagedList,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  const sharedProjectState = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "sharedProjects:state",
    tag: WS_METHODS.sharedProjectsState,
    staleTimeMs: 0,
    idleTtlMs: 0,
    refreshIntervalMs: 15_000,
  });
  const sharedProjectEnrollmentState = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "sharedProjects:enrollmentState",
    tag: WS_METHODS.sharedProjectEnrollmentState,
    staleTimeMs: 0,
    idleTtlMs: 0,
    refreshIntervalMs: 15_000,
  });
  const sharedProjectGrant = createEnvironmentRpcCommand(runtime, {
    label: "sharedProjects:grant",
    tag: WS_METHODS.sharedProjectGrant,
  });
  const sharedProjectEnrollmentCommand = createEnvironmentRpcCommand(runtime, {
    label: "sharedProjects:enrollmentCommand",
    tag: WS_METHODS.sharedProjectEnrollmentCommand,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => {
        registry.refresh(sharedProjectEnrollmentState({ environmentId, input: {} }));
        registry.refresh(sharedProjectState({ environmentId, input: {} }));
      }),
  });
  const enrollSharedProject = createRuntimeCommand(runtime, {
    label: "sharedProjects:enroll",
    execute: Effect.fn("SharedProjects.enroll")(function* (
      input: {
        readonly ownerId: EnvironmentId;
        readonly destinationId: EnvironmentId;
        readonly sharedProjectId: string;
        readonly sourceUrl: string;
      },
      registry,
    ) {
      const grant = yield* Effect.promise(() =>
        sharedProjectGrant.run(registry, {
          environmentId: input.ownerId,
          input: {
            sharedProjectId: input.sharedProjectId,
            destinationEnvironmentId: input.destinationId,
            revoke: false,
          },
        }),
      );
      if (grant._tag === "Failure") return yield* Effect.failCause(grant.cause);
      if (!grant.value.token) return yield* new SharedProjectError({ reason: "denied" });
      const result = yield* Effect.promise(() =>
        sharedProjectEnrollmentCommand.run(registry, {
          environmentId: input.destinationId,
          input: {
            operation: "connect",
            sharedProjectId: input.sharedProjectId,
            ownerEnvironmentId: input.ownerId,
            sourceUrl: input.sourceUrl,
            token: grant.value.token!,
          },
        }),
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    }),
  });
  const refreshManaged = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(managedContainers({ environmentId, input: {} }));
      registry.refresh(managedContainers({ environmentId, input: { threadId } }));
    });
  return {
    memoryState,
    memoryStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "memory:status",
      tag: WS_METHODS.memoryStatus,
      staleTimeMs: 0,
    }),
    memoryQuery,
    memoryCommand,
    memoryGrant,
    enroll,
    managedContainers,
    sharedProjectState,
    sharedProjectEnrollmentState,
    sharedProjectGrant,
    sharedProjectEnrollmentCommand,
    enrollSharedProject,
    sharedProjectPublish: createEnvironmentRpcCommand(runtime, {
      label: "sharedProjects:publish",
      tag: WS_METHODS.sharedProjectsPublish,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(sharedProjectState({ environmentId, input: {} }))),
    }),
    sharedProjectBind: createEnvironmentRpcCommand(runtime, {
      label: "sharedProjects:bind",
      tag: WS_METHODS.sharedProjectsBind,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(sharedProjectState({ environmentId, input: {} }))),
    }),
    sharedProjectUnbind: createEnvironmentRpcCommand(runtime, {
      label: "sharedProjects:unbind",
      tag: WS_METHODS.sharedProjectsUnbind,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(sharedProjectState({ environmentId, input: {} }))),
    }),
    managedContainerCreate: createEnvironmentRpcCommand(runtime, {
      label: "containers:create",
      tag: WS_METHODS.containersManagedCreate,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshManaged(environmentId, input.threadId, registry),
    }),
    managedContainerCommand: createEnvironmentRpcCommand(runtime, {
      label: "containers:command",
      tag: WS_METHODS.containersManagedCommand,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshManaged(environmentId, input.threadId, registry),
    }),
    containers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "containers:subscribe",
      tag: WS_METHODS.containersSubscribe,
      idleTtlMs: 0,
    }),
    containerSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "containers:snapshot",
      tag: WS_METHODS.containersSnapshot,
      staleTimeMs: 0,
    }),
    containerLogs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "containers:logs",
      idleTtlMs: 0,
      tag: WS_METHODS.containersLogs,
      staleTimeMs: 0,
    }),
    containerAssociate: createEnvironmentRpcCommand(runtime, {
      label: "containers:associate",
      tag: WS_METHODS.containersAssociate,
    }),
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
