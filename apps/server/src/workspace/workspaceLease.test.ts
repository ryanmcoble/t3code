import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { withWorkspaceLease, withWorkspaceLeases } from "./workspaceLease.ts";

it.effect("allows nested operations in the owning fiber without releasing the outer lease", () =>
  Effect.gen(function* () {
    const key = "lease-nested-owner";
    const value = yield* withWorkspaceLease(key, withWorkspaceLease(key, Effect.succeed(42)));
    assert.equal(value, 42);
    assert.equal(yield* withWorkspaceLease(key, Effect.succeed(63)), 63);
  }),
);

it.effect("does not let a child fiber inherit its parent's ownership", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const child = yield* withWorkspaceLease(
      "lease-parent-child",
      Effect.gen(function* () {
        const child = yield* withWorkspaceLease(
          "lease-parent-child",
          Deferred.succeed(entered, undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        assert.isFalse(yield* Deferred.isDone(entered));
        return child;
      }),
    );
    yield* Fiber.join(child);
    assert.isTrue(yield* Deferred.isDone(entered));
  }).pipe(Effect.scoped),
);

it.effect("orders multiple roots consistently and takes duplicate paths once", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const otherEntered = yield* Deferred.make<void>();
    const first = yield* withWorkspaceLeases(
      ["lease-root-a", "lease-root-b", "lease-root-a"],
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const second = yield* withWorkspaceLeases(
      ["lease-root-b", "lease-root-a"],
      Deferred.succeed(otherEntered, undefined),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    assert.isFalse(yield* Deferred.isDone(otherEntered));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.isTrue(yield* Deferred.isDone(otherEntered));
  }).pipe(Effect.scoped),
);

it.effect("releases ownership when a holder is interrupted and removes a cancelled waiter", () =>
  Effect.gen(function* () {
    const key = "lease-cancelled-waiter";
    const holder = yield* withWorkspaceLease(key, Effect.never).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const waiter = yield* withWorkspaceLease(
      key,
      Effect.die("cancelled waiter must never enter"),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.interrupt(waiter);
    yield* Fiber.interrupt(holder);
    assert.equal(yield* withWorkspaceLease(key, Effect.succeed("recovered")), "recovered");
  }).pipe(Effect.scoped),
);
