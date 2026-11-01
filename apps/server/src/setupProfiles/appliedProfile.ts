import * as Effect from "effect/Effect";
import * as SetupProfileStore from "./SetupProfileStore.ts";

export const readAppliedProfile = Effect.gen(function* () {
  const store = yield* SetupProfileStore.SetupProfileStore;
  const binding = yield* store.binding;
  if (!binding || !binding.appliedRevision) return null;
  const profile = yield* store.get(
    binding.lastApplied?.profileId ?? binding.profile.id,
    binding.lastApplied?.revision ?? binding.appliedRevision,
  );
  return { profile, instanceIds: binding.lastApplied?.instanceIds ?? binding.instanceIds };
});
