import { SetupProfileError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SetupProfiles from "./SetupProfiles.ts";

export const start = Effect.gen(function* () {
  const profiles = yield* SetupProfiles.SetupProfiles;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  yield* profiles.restoreRuntime.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Cached setup could not be restored", { reason: error.reason }),
    ),
  );
  const reconcile = profiles.reconcile(
    (ids) =>
      Effect.forEach(
        ids,
        (id) =>
          sessions
            .closeIdleInstance(id)
            .pipe(
              Effect.flatMap((closed) =>
                closed ? Effect.void : Effect.fail(new SetupProfileError({ reason: "conflict" })),
              ),
            ),
        { discard: true },
      ).pipe(Effect.mapError((cause) => new SetupProfileError({ reason: "storage", cause }))),
    (ids) =>
      Effect.forEach(
        ids,
        (id) => (Option.isSome(registry) ? registry.value.refreshInstance(id) : Effect.void),
        { discard: true },
      ),
  );
  yield* reconcile.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Setup profile reconciliation failed", { reason: error.reason }),
    ),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkScoped,
  );
});
