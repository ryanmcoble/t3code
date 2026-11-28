import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { withWorkspaceLease, withWorkspaceLeases } from "./workspaceLease.ts";

it.effect(
  "lets a queued parent finish before later children and removes cancelled hierarchy waiters",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const parentEntered = yield* Deferred.make<void>();
      const parentRelease = yield* Deferred.make<void>();
      const childEntered = yield* Deferred.make<void>();
      const first = yield* withWorkspaceLease("lease-fair/left", Deferred.await(release)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const parent = yield* withWorkspaceLease(
        "lease-fair",
        Deferred.succeed(parentEntered, undefined).pipe(
          Effect.andThen(Deferred.await(parentRelease)),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const later = yield* withWorkspaceLease(
        "lease-fair/right",
        Deferred.succeed(childEntered, undefined),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(yield* Deferred.isDone(childEntered));
      assert.equal(yield* withWorkspaceLease("lease-fair-unrelated", Effect.succeed(42)), 42);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Deferred.await(parentEntered);
      assert.isFalse(yield* Deferred.isDone(childEntered));
      yield* Fiber.interrupt(later);
      yield* Deferred.succeed(parentRelease, undefined);
      yield* Fiber.join(parent);
      assert.equal(yield* withWorkspaceLease("lease-fair", Effect.succeed(63)), 63);
    }).pipe(Effect.scoped),
);

it.effect("fails a contended nested expansion instead of deadlocking two root owners", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const other = yield* withWorkspaceLease("lease-expand/right", Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const expanded = yield* withWorkspaceLease(
      "lease-expand/left",
      withWorkspaceLease("lease-expand", Effect.void),
    ).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(expanded));
    if (Exit.isFailure(expanded)) assert.isTrue(Cause.hasDies(expanded.cause));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(other);
    assert.equal(
      yield* withWorkspaceLeases(["lease-expand/left", "lease-expand/right"], Effect.succeed(42)),
      42,
    );
  }).pipe(Effect.scoped),
);

it.effect("fences descendant folders while unrelated and sibling folders remain concurrent", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const childEntered = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease("lease-hierarchy", Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const child = yield* withWorkspaceLease(
      "lease-hierarchy/nested/terminal",
      Deferred.succeed(childEntered, undefined),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    assert.isFalse(yield* Deferred.isDone(childEntered));
    assert.equal(yield* withWorkspaceLease("lease-hierarchy-unrelated", Effect.succeed(42)), 42);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(child);
    const siblingRelease = yield* Deferred.make<void>();
    const left = yield* withWorkspaceLease(
      "lease-hierarchy/left",
      Deferred.await(siblingRelease),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    assert.equal(yield* withWorkspaceLease("lease-hierarchy/right", Effect.succeed(63)), 63);
    yield* Deferred.succeed(siblingRelease, undefined);
    yield* Fiber.join(left);
    assert.equal(
      yield* withWorkspaceLease(
        "lease-hierarchy",
        withWorkspaceLease("lease-hierarchy/nested", Effect.succeed(99)),
      ),
      99,
    );
  }).pipe(Effect.scoped),
);

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
