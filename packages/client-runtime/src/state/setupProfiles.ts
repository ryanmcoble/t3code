import {
  SetupProfileError,
  WS_METHODS,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
} from "./runtime.ts";

export function createSetupProfileAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "setup-profiles:state",
    tag: WS_METHODS.setupProfilesSubscribe,
  });
  const command = createEnvironmentRpcCommand(runtime, {
    label: "setup-profiles:command",
    tag: WS_METHODS.setupProfilesCommand,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(state({ environmentId, input: {} }))),
  });
  const grant = createEnvironmentRpcCommand(runtime, {
    label: "setup-profiles:grant",
    tag: WS_METHODS.setupProfilesGrant,
  });
  const enroll = createRuntimeCommand(runtime, {
    label: "setup-profiles:enroll",
    execute: Effect.fn("SetupProfiles.enroll")(function* (
      input: {
        readonly ownerId: EnvironmentId;
        readonly destinationId: EnvironmentId;
        readonly profileId: string;
        readonly sourceUrl: string;
        readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
      },
      registry,
    ) {
      const access = yield* Effect.promise(() =>
        grant.run(registry, {
          environmentId: input.ownerId,
          input: {
            profileId: input.profileId,
            destinationEnvironmentId: input.destinationId,
            revoke: false,
          },
        }),
      );
      if (access._tag === "Failure") return yield* Effect.failCause(access.cause);
      if (access.value.token === null) return yield* new SetupProfileError({ reason: "denied" });
      const result = yield* Effect.promise(() =>
        command.run(registry, {
          environmentId: input.destinationId,
          input: {
            operation: "subscribe",
            ownerEnvironmentId: input.ownerId,
            profileId: input.profileId,
            sourceUrl: input.sourceUrl,
            token: access.value.token!,
            instanceIds: input.instanceIds,
          },
        }),
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      return result.value;
    }),
  });
  return {
    state,
    command,
    grant,
    enroll,
    importSetup: createEnvironmentRpcCommand(runtime, {
      label: "setup-profiles:import",
      tag: WS_METHODS.setupProfilesImport,
    }),
  };
}
