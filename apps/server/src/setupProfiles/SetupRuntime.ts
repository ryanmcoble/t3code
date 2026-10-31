import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ResolvedSetupConnection } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export class SetupRuntime extends Context.Service<
  SetupRuntime,
  {
    readonly read: (
      id: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ResolvedSetupConnection>>;
    readonly replace: (
      values: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ResolvedSetupConnection>>,
    ) => Effect.Effect<void>;
    readonly stable: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/setupProfiles/SetupRuntime") {}

const make = Effect.gen(function* () {
  const values = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<ResolvedSetupConnection>>
  >(new Map());
  const gate = yield* Semaphore.make(1);
  return SetupRuntime.of({
    read: Effect.fn("SetupRuntime.read")((id) =>
      Ref.get(values).pipe(Effect.map((values) => values.get(id) ?? [])),
    ),
    replace: Effect.fn("SetupRuntime.replace")((next) => Ref.set(values, next)),
    stable: gate.withPermits(1),
  });
});

export const layer = Layer.effect(SetupRuntime, make);
