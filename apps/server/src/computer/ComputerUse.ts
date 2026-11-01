import * as SetupProfileStore from "../setupProfiles/SetupProfileStore.ts";
import { readAppliedProfile } from "../setupProfiles/appliedProfile.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ComputerUseConfig,
  ComputerLease,
  ComputerUseState,
  ComputerUseCommand,
  ComputerAction,
  ComputerDriverResult,
  ComputerUseError,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ComputerDriver from "./ComputerDriver.ts";

export interface ComputerActor {
  readonly id: string;
  readonly label: string;
  readonly providerInstanceId: ProviderInstanceId;
}
export class ComputerUse extends Context.Service<
  ComputerUse,
  {
    readonly state: Effect.Effect<typeof ComputerUseState.Type, ComputerUseError>;
    readonly command: (
      input: typeof ComputerUseCommand.Type,
    ) => Effect.Effect<void, ComputerUseError>;
    readonly apps: (
      actor: ComputerActor,
    ) => Effect.Effect<typeof ComputerDriverResult.Type, ComputerUseError>;
    readonly acquire: (
      actor: ComputerActor,
      pid: number,
      bundleId: string,
      windowId: number,
    ) => Effect.Effect<ComputerLease, ComputerUseError>;
    readonly observe: (
      actor: ComputerActor,
      leaseId: string,
      windowId: number,
    ) => Effect.Effect<typeof ComputerDriverResult.Type, ComputerUseError>;
    readonly act: (
      actor: ComputerActor,
      leaseId: string,
      action: typeof ComputerAction.Type,
    ) => Effect.Effect<void, ComputerUseError>;
    readonly release: (
      actor: ComputerActor,
      leaseId: string,
    ) => Effect.Effect<void, ComputerUseError>;
  }
>()("t3/computer/ComputerUse") {}
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ComputerUseConfig));
const decodeLease = Schema.decodeUnknownEffect(Schema.fromJsonString(ComputerLease));
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const App = Schema.Struct({
  pid: Schema.Int,
  bundle_id: Schema.optionalKey(Schema.String),
  executable: Schema.optionalKey(Schema.String),
});
const decodeApps = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Array(App), Schema.Struct({ apps: Schema.Array(App) })]),
  ),
);
const decodeWindows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      windows: Schema.Array(
        Schema.Struct({
          pid: Schema.Int,
          window_id: Schema.Int,
          title: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);
const decodePermissions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ accessibility: Schema.Boolean, screen_recording: Schema.Boolean }),
  ),
);
const isComputerError = Schema.is(ComputerUseError);
const storage = (cause: unknown) =>
  isComputerError(cause) ? cause : new ComputerUseError({ reason: "storage", cause });
const defaultConfig: ComputerUseConfig = {
  enabled: false,
  command: "cua-driver",
  providerInstanceIds: [],
  allowedApps: [],
};
const LEASE_MS = 120_000;
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const appliedProfile = readAppliedProfile.pipe(
    Effect.provideService(
      SetupProfileStore.SetupProfileStore,
      yield* SetupProfileStore.SetupProfileStore,
    ),
  );
  const driver = yield* ComputerDriver.ComputerDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const gate = yield* Semaphore.make(1);
  const administration = yield* Semaphore.make(1);
  const revoking = yield* Ref.make(false);
  const active = yield* Ref.make<Fiber.Fiber<unknown, ComputerUseError> | undefined>(undefined);
  const profileConfig = Effect.gen(function* () {
    const applied = yield* appliedProfile;
    const policy = applied?.profile.computerUse;
    if (!applied || !policy) return defaultConfig;
    const current = yield* settings.getSettings;
    return {
      enabled: policy.enabled,
      command: "cua-driver",
      allowedApps: policy.allowedApps,
      providerInstanceIds: applied.instanceIds.filter(
        (id) =>
          !policy.drivers.length ||
          policy.drivers.includes(current.providerInstances[id]?.driver ?? ""),
      ),
    };
  });
  const read = Effect.gen(function* () {
    const rows = yield* sql<{
      config: string;
      lease: string | null;
      inherited: number;
    }>`SELECT config,lease,inherited FROM computer_use_state WHERE id=1`;
    const row = rows[0];
    const config = !row || row.inherited ? yield* profileConfig : yield* decodeConfig(row.config);
    const lease = row?.lease ? yield* decodeLease(row.lease) : null;
    return {
      config,
      inherited: !row || Boolean(row.inherited),
      lease: lease && lease.expiresAt > (yield* Clock.currentTimeMillis) ? lease : null,
    };
  }).pipe(Effect.mapError(storage));
  const save = Effect.fn("ComputerUse.save")(function* (
    config: ComputerUseConfig,
    lease: ComputerLease | null,
    inherited = false,
  ) {
    const configJson = yield* encode(config);
    const leaseJson = lease ? yield* encode(lease) : null;
    yield* sql`INSERT INTO computer_use_state(id,config,lease,inherited) VALUES (1,${configJson},${leaseJson},${inherited ? 1 : 0}) ON CONFLICT(id) DO UPDATE SET config=excluded.config,lease=excluded.lease,inherited=excluded.inherited`;
  }, Effect.mapError(storage));
  const allowed = Effect.fn("ComputerUse.allowed")(function* (actor: ComputerActor) {
    if (yield* Ref.get(revoking)) return yield* new ComputerUseError({ reason: "expired" });
    const state = yield* read;
    if (!state.config.enabled) return yield* new ComputerUseError({ reason: "disabled" });
    if (!state.config.providerInstanceIds.includes(actor.providerInstanceId))
      return yield* new ComputerUseError({ reason: "denied" });
    return state;
  });
  const call = Effect.fn("ComputerUse.call")(function* (
    command: string,
    tool: string,
    input: Readonly<Record<string, unknown>>,
  ) {
    if (yield* Ref.get(revoking)) return yield* new ComputerUseError({ reason: "expired" });
    const fiber = yield* driver.call(command, tool, input).pipe(Effect.forkChild);
    yield* Ref.set(active, fiber);
    return yield* Fiber.join(fiber).pipe(Effect.ensuring(Ref.set(active, undefined)));
  });
  const stop = Effect.gen(function* () {
    const fiber = yield* Ref.get(active);
    if (fiber) yield* Fiber.interrupt(fiber);
  });
  const leaseFor = Effect.fn("ComputerUse.leaseFor")(function* (actor: ComputerActor, id: string) {
    const state = yield* allowed(actor);
    if (
      !state.lease ||
      state.lease.id !== id ||
      state.lease.owner !== actor.id ||
      !state.config.allowedApps.includes(state.lease.bundleId)
    )
      return yield* new ComputerUseError({ reason: "expired" });
    return {
      config: state.config,
      inherited: state.inherited,
      lease: { ...state.lease, expiresAt: (yield* Clock.currentTimeMillis) + LEASE_MS },
    };
  });
  return ComputerUse.of({
    state: Effect.gen(function* () {
      const state = yield* read;
      if (!state.config.enabled)
        return {
          ...state,
          readiness: "disabled" as const,
          message: "Enable computer use and select allowed harnesses and apps.",
        };
      const permissions = yield* driver
        .call(state.config.command, "check_permissions", {
          prompt: false,
          probe_direct_capture: false,
        })
        .pipe(Effect.result);
      if (permissions._tag === "Failure")
        return {
          ...state,
          readiness: "unavailable" as const,
          message:
            "Install and start Cua Driver in this desktop session, then grant its OS permissions.",
        };
      const text = permissions.success.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const parsed = yield* decodePermissions(text).pipe(Effect.result);
      const ready =
        parsed._tag === "Success" &&
        parsed.success.accessibility &&
        parsed.success.screen_recording;
      return {
        ...state,
        readiness: ready ? ("ready" as const) : ("needs-permission" as const),
        message: ready
          ? "OS permissions reported. Observing an allowed app verifies desktop capture."
          : "Accessibility or Screen Recording is missing or could not be verified. Enable both for Cua Driver on this machine.",
      };
    }),
    command: Effect.fn("ComputerUse.command")(function* (input) {
      if (
        input.operation === "configure" &&
        input.config.enabled &&
        !input.config.allowedApps.length
      )
        return yield* new ComputerUseError({ reason: "denied" });
      yield* administration.withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.set(revoking, true);
          yield* stop;
          yield* gate.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* read;
              if (state.lease)
                yield* driver
                  .call(state.config.command, "end_session", { session: state.lease.id })
                  .pipe(Effect.orElseSucceed(() => ({ content: [] })));
              if (input.operation === "inherit")
                yield* sql`DELETE FROM computer_use_state WHERE id=1`.pipe(
                  Effect.mapError(storage),
                );
              else
                yield* save(
                  input.operation === "configure" ? input.config : state.config,
                  null,
                  input.operation !== "configure" && state.inherited,
                );
            }),
          );
        }).pipe(Effect.ensuring(Ref.set(revoking, false))),
      );
    }),
    apps: Effect.fn("ComputerUse.apps")(function* (actor) {
      const { config } = yield* allowed(actor);
      const result = yield* driver.call(config.command, "list_apps", {});
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const parsed = yield* decodeApps(text).pipe(
        Effect.mapError((cause) => new ComputerUseError({ reason: "driver", cause })),
      );
      const list = ("apps" in parsed ? parsed.apps : parsed).filter((app) =>
        config.allowedApps.includes(app.bundle_id ?? app.executable ?? ""),
      );
      const windows = yield* Effect.forEach(
        list.filter((app) => app.pid > 0),
        (app) =>
          driver.call(config.command, "list_windows", { pid: app.pid }).pipe(
            Effect.flatMap((value) =>
              decodeWindows(
                value.content
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n"),
              ),
            ),
            Effect.mapError((cause) => new ComputerUseError({ reason: "driver", cause })),
          ),
      );
      const output = yield* encode({
        apps: list,
        windows: windows.flatMap((item) => item.windows),
      }).pipe(Effect.mapError(storage));
      return { content: [{ type: "text" as const, text: output }] };
    }),
    acquire: Effect.fn("ComputerUse.acquire")(function* (actor, pid, bundleId, windowId) {
      return yield* gate.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* allowed(actor);
          if (!state.config.allowedApps.includes(bundleId))
            return yield* new ComputerUseError({ reason: "denied" });
          if (state.lease) {
            if (
              state.lease.owner !== actor.id ||
              state.lease.appPid !== pid ||
              state.lease.bundleId !== bundleId ||
              state.lease.windowId !== windowId
            )
              return yield* new ComputerUseError({ reason: "busy" });
            const renewed = {
              ...state.lease,
              expiresAt: (yield* Clock.currentTimeMillis) + LEASE_MS,
            };
            yield* save(state.config, renewed, state.inherited);
            return renewed;
          }
          const apps = yield* call(state.config.command, "list_apps", {});
          const text = apps.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
          const parsed = yield* decodeApps(text).pipe(
            Effect.mapError((cause) => new ComputerUseError({ reason: "driver", cause })),
          );
          const list = "apps" in parsed ? parsed.apps : parsed;
          if (
            !list.some((app) => app.pid === pid && (app.bundle_id ?? app.executable) === bundleId)
          )
            return yield* new ComputerUseError({ reason: "denied" });
          const windowResult = yield* call(state.config.command, "list_windows", { pid });
          const windows = yield* decodeWindows(
            windowResult.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n"),
          ).pipe(Effect.mapError((cause) => new ComputerUseError({ reason: "driver", cause })));
          if (
            !windows.windows.some((window) => window.pid === pid && window.window_id === windowId)
          )
            return yield* new ComputerUseError({ reason: "denied" });
          const lease: ComputerLease = {
            id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
            owner: actor.id,
            label: actor.label,
            appPid: pid,
            windowId,
            bundleId,
            expiresAt: (yield* Clock.currentTimeMillis) + LEASE_MS,
          };
          yield* call(state.config.command, "start_session", { session: lease.id });
          yield* save(state.config, lease, state.inherited);
          return lease;
        }),
      );
    }),
    observe: Effect.fn("ComputerUse.observe")(function* (actor, id, windowId) {
      return yield* gate.withPermits(1)(
        Effect.gen(function* () {
          const { config, lease, inherited } = yield* leaseFor(actor, id);
          if (lease.windowId !== windowId) return yield* new ComputerUseError({ reason: "denied" });
          yield* save(config, lease, inherited);
          return yield* call(config.command, "get_window_state", {
            pid: lease.appPid,
            window_id: windowId,
            session: lease.id,
          });
        }),
      );
    }),
    act: Effect.fn("ComputerUse.act")(function* (actor, id, action) {
      yield* gate.withPermits(1)(
        Effect.gen(function* () {
          const { config, lease, inherited } = yield* leaseFor(actor, id);
          yield* save(config, lease, inherited);
          const input = {
            target: { kind: "window", pid: lease.appPid, window_id: lease.windowId },
            session: lease.id,
          };
          switch (action.kind) {
            case "click":
              yield* call(config.command, "click", { ...input, x: action.x, y: action.y });
              break;
            case "type":
              yield* call(config.command, "type_text", { ...input, text: action.text });
              break;
            case "key":
              yield* call(config.command, "press_key", {
                ...input,
                key: action.key,
                modifiers: action.modifiers ?? [],
              });
              break;
            case "scroll":
              yield* call(config.command, "scroll", {
                ...input,
                x: action.x,
                y: action.y,
                direction: action.direction,
                amount: action.amount,
              });
              break;
          }
        }),
      );
    }),
    release: Effect.fn("ComputerUse.release")(function* (actor, id) {
      yield* administration.withPermits(1)(
        Effect.gen(function* () {
          yield* leaseFor(actor, id);
          yield* Ref.set(revoking, true);
          yield* stop;
          yield* gate.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* read;
              if (state.lease?.id !== id || state.lease.owner !== actor.id)
                return yield* new ComputerUseError({ reason: "expired" });
              yield* driver
                .call(state.config.command, "end_session", { session: id })
                .pipe(Effect.orElseSucceed(() => ({ content: [] })));
              yield* save(state.config, null, state.inherited);
            }),
          );
        }).pipe(Effect.ensuring(Ref.set(revoking, false))),
      );
    }),
  });
});
export const layer = Layer.effect(ComputerUse, make);
