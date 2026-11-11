// @effect-diagnostics-next-line nodeBuiltinImport:off -- Lock keys need synchronous platform path normalization at existing call sites.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

interface Lease {
  readonly roots: ReadonlyArray<string>;
  readonly ownerId: number;
  readonly ready: Deferred.Deferred<void>;
  active: boolean;
}

const active = new Set<Lease>();
const waiting: Lease[] = [];
const heldLeases = Context.Reference<ReadonlySet<Lease>>("t3/workspace/HeldLeases", {
  defaultValue: () => new Set(),
});

const contains = (parent: string, child: string) => {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};
const overlaps = (left: Lease, right: Lease) =>
  left.roots.some((a) => right.roots.some((b) => contains(a, b) || contains(b, a)));
const normalize = (cwd: string) => {
  // Conservatively share locks for case and Unicode aliases, including on case-sensitive volumes.
  return NodePath.resolve(cwd).normalize("NFC").toLowerCase();
};

export const workspacePathsOverlap = (left: string, right: string): boolean => {
  const a = normalize(left);
  const b = normalize(right);
  return contains(a, b) || contains(b, a);
};
const drain = () => {
  const blocked: Lease[] = [];
  for (let index = 0; index < waiting.length;) {
    const lease = waiting[index]!;
    if (
      [...active].some((other) => other.ownerId !== lease.ownerId && overlaps(other, lease)) ||
      blocked.some((other) => overlaps(other, lease))
    ) {
      blocked.push(lease);
      index++;
      continue;
    }
    waiting.splice(index, 1);
    active.add(lease);
    lease.active = true;
    Deferred.doneUnsafe(lease.ready, Effect.void);
  }
};

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => withWorkspaceLeases([cwd], effect);

export const withWorkspaceLeases = <A, E, R>(
  cwds: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) =>
    Effect.suspend(() => {
      const roots = [...new Set(cwds.map(normalize))].sort();
      const held = [...fiber.getRef(heldLeases)].filter(
        (lease) => lease.active && lease.ownerId === fiber.id,
      );
      // Child fibers inherit context, but only the owning fiber can reenter a covered subtree.
      if (
        roots.every((root) =>
          held.some((lease) => lease.roots.some((parent) => contains(parent, root))),
        )
      )
        return effect;
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          const lease: Lease = {
            roots,
            ownerId: fiber.id,
            ready: Deferred.makeUnsafe<void>(),
            active: false,
          };
          waiting.push(lease);
          drain();
          return lease;
        }),
        (lease) => {
          // Waiting while holding another root can deadlock an inverse nested acquisition.
          if (held.length > 0 && !lease.active)
            return Effect.die(
              new Error(
                "Acquire all workspace roots together before entering a contended nested workspace operation.",
              ),
            );
          return Deferred.await(lease.ready).pipe(
            Effect.andThen(
              effect.pipe(Effect.provideService(heldLeases, new Set([...held, lease]))),
            ),
          );
        },
        (lease) =>
          Effect.sync(() => {
            lease.active = false;
            active.delete(lease);
            const index = waiting.indexOf(lease);
            if (index >= 0) waiting.splice(index, 1);
            drain();
          }),
      );
    }),
  );
