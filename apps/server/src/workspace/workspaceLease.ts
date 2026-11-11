import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
const heldLeases = Context.Reference<
  ReadonlyMap<string, { readonly ownerId: number; active: boolean }>
>("t3/workspace/HeldLeases", { defaultValue: () => new Map() });

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const held = fiber.getRef(heldLeases);
    const current = held.get(cwd);
    // Forked fibers inherit context, but cannot inherit ownership or outlive the holding scope.
    if (current?.active && current.ownerId === fiber.id) return effect;
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore
      .withPermit(
        Effect.suspend(() => {
          const owner = { ownerId: fiber.id, active: true };
          const next = new Map(held);
          next.set(cwd, owner);
          return effect.pipe(
            Effect.provideService(heldLeases, next),
            Effect.ensuring(
              Effect.sync(() => {
                owner.active = false;
              }),
            ),
          );
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lease.users--;
            if (lease.users === 0) leases.delete(cwd);
          }),
        ),
      );
  });

export function withWorkspaceLeases<A, E, R>(
  cwds: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  let leased = effect;
  for (const cwd of [...new Set(cwds)].sort().reverse()) leased = withWorkspaceLease(cwd, leased);
  return leased;
}
