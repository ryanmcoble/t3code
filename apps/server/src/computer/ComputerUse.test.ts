import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ComputerUseError, ProviderInstanceId, EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SetupProfileStore from "../setupProfiles/SetupProfileStore.ts";
import * as ComputerDriver from "./ComputerDriver.ts";
import * as ComputerUse from "./ComputerUse.ts";

const provider = ProviderInstanceId.make("codex");
const actor = { id: "thread-a", label: "Task A", providerInstanceId: provider };
const other = { id: "thread-b", label: "Task B", providerInstanceId: provider };
const config = {
  enabled: true,
  command: "/tools/cua-driver",
  providerInstanceIds: [provider],
  allowedApps: ["com.acme.calculator"],
};
const apps = {
  content: [
    { type: "text" as const, text: '{"apps":[{"pid":42,"bundle_id":"com.acme.calculator"}]}' },
  ],
};
const windows = {
  content: [{ type: "text" as const, text: '{"windows":[{"pid":42,"window_id":100}]}' }],
};
const done = { content: [{ type: "text" as const, text: "done" }] };
const withComputer = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  driver: ComputerDriver.ComputerDriver["Service"],
) =>
  run.pipe(
    Effect.provide(
      ComputerUse.layer.pipe(
        Layer.provide(Layer.succeed(ComputerDriver.ComputerDriver, driver)),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest({})),
        Layer.provideMerge(SetupProfileStore.layer),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provide(NodeServices.layer),
        Layer.fresh,
      ),
    ),
  );

it.effect(
  "allows one desktop owner, binds PID to an allowed app, and rejects another caller's lease",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<
        ReadonlyArray<{ tool: string; input: Readonly<Record<string, unknown>> }>
      >([]);
      yield* withComputer(
        Effect.gen(function* () {
          const computer = yield* ComputerUse.ComputerUse;
          assert.equal((yield* computer.apps(actor).pipe(Effect.result))._tag, "Failure");
          assert.equal((yield* Ref.get(calls)).length, 0);
          yield* computer.command({ operation: "configure", config });
          const lease = yield* computer.acquire(actor, 42, config.allowedApps[0]!, 100);
          assert.equal(
            (yield* computer.acquire(other, 42, config.allowedApps[0]!, 100).pipe(Effect.result))
              ._tag,
            "Failure",
          );
          assert.equal(
            (yield* computer.acquire(actor, 41, config.allowedApps[0]!, 100).pipe(Effect.result))
              ._tag,
            "Failure",
          );
          assert.equal(
            (yield* computer
              .act(other, lease.id, { kind: "key", key: "return" })
              .pipe(Effect.result))._tag,
            "Failure",
          );
          yield* computer.act(actor, lease.id, { kind: "key", key: "return" });
          assert.equal(
            (yield* Ref.get(calls)).filter((request) => request.tool === "press_key").length,
            1,
          );
          assert.deepEqual(
            (yield* Ref.get(calls)).find((request) => request.tool === "press_key")?.input.target,
            { kind: "window", pid: 42, window_id: 100 },
          );
          yield* computer.release(actor, lease.id);
          assert.equal(
            (yield* computer
              .act(actor, lease.id, { kind: "click", x: 0, y: 0 })
              .pipe(Effect.result))._tag,
            "Failure",
          );
          assert.equal(
            (yield* computer.acquire(other, 42, config.allowedApps[0]!, 100)).owner,
            other.id,
          );
        }),
        {
          call: (_command, tool, input) =>
            Ref.update(calls, (value) => [...value, { tool, input }]).pipe(
              Effect.as(tool === "list_apps" ? apps : tool === "list_windows" ? windows : done),
            ),
        },
      );
    }),
);

it.effect("expires idle leases and rejects a disabled harness without issuing input", () =>
  withComputer(
    Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      yield* computer.command({ operation: "configure", config });
      const lease = yield* computer.acquire(actor, 42, config.allowedApps[0]!, 100);
      yield* TestClock.adjust("121 seconds");
      assert.equal(
        (yield* computer.observe(actor, lease.id, 1).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* computer.acquire(other, 42, config.allowedApps[0]!, 100);
      yield* computer.command({ operation: "configure", config: { ...config, enabled: false } });
      assert.equal((yield* computer.state).readiness, "disabled");
      assert.equal((yield* computer.apps(other).pipe(Effect.result))._tag, "Failure");
    }),
    {
      call: (_command, tool) =>
        Effect.succeed(tool === "list_apps" ? apps : tool === "list_windows" ? windows : done),
    },
  ),
);

it.effect("user release interrupts a pending driver operation and invalidates the lease", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const pending = yield* Deferred.make<never, ComputerUseError>();
    yield* withComputer(
      Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        yield* computer.command({ operation: "configure", config });
        const lease = yield* computer.acquire(actor, 42, config.allowedApps[0]!, 100);
        const operation = yield* computer
          .act(actor, lease.id, { kind: "click", x: 10, y: 10 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* computer.command({ operation: "release" });
        assert.equal((yield* Fiber.await(operation))._tag, "Failure");
        assert.isNull((yield* computer.state).lease);
        assert.equal(
          (yield* computer.act(actor, lease.id, { kind: "key", key: "return" }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
      }),
      {
        call: (_command, tool) =>
          tool === "click"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(pending)))
            : Effect.succeed(
                tool === "list_apps" ? apps : tool === "list_windows" ? windows : done,
              ),
      },
    );
  }),
);

it.effect(
  "keeps desktop policy inherited through lease writes and supports explicit local overrides",
  () =>
    withComputer(
      Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const store = yield* SetupProfileStore.SetupProfileStore;
        const profile = {
          id: "setup",
          ownerEnvironmentId: EnvironmentId.make("owner"),
          name: "Development",
          revision: 1,
          schemaVersion: 1 as const,
          connections: [],
          skills: [],
          computerUse: { enabled: true, allowedApps: config.allowedApps, drivers: [] },
        };
        yield* store.publish(profile, 0);
        const binding = {
          profile,
          sourceUrl: null,
          instanceIds: [provider],
          enabled: true,
          observedRevision: 1,
          appliedRevision: 1,
          items: [],
          error: null,
        };
        yield* store.saveBinding(binding);
        assert.deepEqual((yield* computer.state).config.allowedApps, config.allowedApps);
        const lease = yield* computer.acquire(actor, 42, config.allowedApps[0]!, 100);
        yield* computer.release(actor, lease.id);
        const updated = {
          ...profile,
          revision: 2,
          computerUse: { ...profile.computerUse, allowedApps: ["com.acme.editor"] },
        };
        yield* store.publish(updated, 1);
        yield* store.saveBinding({
          ...binding,
          profile: updated,
          observedRevision: 2,
          appliedRevision: 2,
        });
        assert.deepEqual((yield* computer.state).config.allowedApps, ["com.acme.editor"]);
        yield* computer.command({ operation: "configure", config });
        assert.deepEqual((yield* computer.state).config.allowedApps, config.allowedApps);
        yield* computer.command({ operation: "inherit" });
        assert.deepEqual((yield* computer.state).config.allowedApps, ["com.acme.editor"]);
      }),
      {
        call: (_command, tool) =>
          Effect.succeed(tool === "list_apps" ? apps : tool === "list_windows" ? windows : done),
      },
    ),
);
