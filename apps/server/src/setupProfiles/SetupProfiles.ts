import { makeSetupImporter } from "../provider/SetupProfileImport.ts";
import * as Stream from "effect/Stream";
import {
  ExecutionEnvironmentDescriptor,
  SetupProfile,
  SetupProfileBinding,
  SetupProfileError,
  type SetupProfileCommand,
  type SetupProfileState,
  type SetupValue,
  type SetupProfileImportInput,
  type SetupProfileImportResult,
  type SetupProfileGrantInput,
  type SetupProfileGrantResult,
  type ProviderInstanceId,
  type SetupItemStatus,
} from "@t3tools/contracts";
import type { ResolvedSetupConnection } from "@t3tools/provider-core/server/mcpSession";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";

import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { nativeSetupLayout } from "../provider/setupProfileAdapter.ts";
import * as SetupProfileStore from "./SetupProfileStore.ts";
import * as SetupPackages from "./SetupPackages.ts";
import * as SetupFiles from "./SetupFiles.ts";
import * as SetupRuntime from "./SetupRuntime.ts";
import { MAX_SETUP_PACKAGE_BYTES, validateSetupProfile, validSetupName } from "./validation.ts";

export class SetupProfiles extends Context.Service<
  SetupProfiles,
  {
    readonly restoreRuntime: Effect.Effect<void, SetupProfileError>;
    readonly changes: Stream.Stream<SetupProfileState, SetupProfileError>;
    readonly state: Effect.Effect<SetupProfileState, SetupProfileError>;
    readonly command: (
      input: SetupProfileCommand,
    ) => Effect.Effect<SetupProfileState, SetupProfileError>;
    readonly importSetup: (
      input: typeof SetupProfileImportInput.Type,
    ) => Effect.Effect<SetupProfileImportResult, SetupProfileError>;
    readonly grant: (
      input: typeof SetupProfileGrantInput.Type,
    ) => Effect.Effect<typeof SetupProfileGrantResult.Type, SetupProfileError>;
    readonly serve: (input: {
      profileId: string;
      revision?: number;
      destinationId: string;
      token: string;
      digest?: string;
    }) => Effect.Effect<SetupProfile | Uint8Array, SetupProfileError>;
    readonly reconcile: (
      reload: (ids: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void, SetupProfileError>,
      refreshed?: (ids: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void>,
    ) => Effect.Effect<void, SetupProfileError>;
  }
>()("t3/setupProfiles/SetupProfiles") {}

const Text = new TextEncoder();
const isSetupError = Schema.is(SetupProfileError);
const decodeProfile = Schema.decodeUnknownEffect(SetupProfile);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const storageError = (cause: unknown) =>
  isSetupError(cause) ? cause : new SetupProfileError({ reason: "storage", cause });
const lastApplied = (binding: SetupProfileBinding | null) =>
  binding?.lastApplied ??
  (binding?.appliedRevision
    ? {
        profileId: binding.profile.id,
        revision: binding.appliedRevision,
        instanceIds: binding.instanceIds,
        detached: binding.detached ?? false,
      }
    : undefined);
const affectedInstances = (binding: SetupProfileBinding) => [
  ...new Set([...binding.instanceIds, ...(lastApplied(binding)?.instanceIds ?? [])]),
];

const make = Effect.gen(function* () {
  const store = yield* SetupProfileStore.SetupProfileStore;
  const packages = yield* SetupPackages.SetupPackages;
  const files = yield* SetupFiles.SetupFiles;
  const runtime = yield* SetupRuntime.SetupRuntime;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const http = yield* HttpClient.HttpClient;
  const importSetup = yield* makeSetupImporter;
  const processEnvironment = yield* HostProcess.Environment;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  let appliedKey = "";
  const state = Effect.gen(function* () {
    const profiles = (yield* store.list).filter((p) => p.ownerEnvironmentId === environmentId);
    return { profiles, binding: yield* store.binding };
  });
  const checked = Effect.fn("SetupProfiles.validate")(
    (profile: Pick<SetupProfile, "connections" | "skills">) =>
      Effect.try({
        try: () => validateSetupProfile(profile),
        catch: () => new SetupProfileError({ reason: "invalid" }),
      }),
  );
  const tokenName = (id: string) => `setup-subscription-${id}`;
  const getToken = Effect.fn("SetupProfiles.getToken")(function* (id: string) {
    const value = yield* secrets.get(tokenName(id)).pipe(Effect.mapError(storageError));
    if (Option.isNone(value)) return yield* new SetupProfileError({ reason: "denied" });
    return new TextDecoder().decode(value.value);
  });
  const request = Effect.fn("SetupProfiles.request")(function* (
    binding: SetupProfileBinding,
    suffix: string,
    overrideToken?: string,
  ) {
    const url = new URL(binding.sourceUrl ?? "");
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    ) {
      return yield* new SetupProfileError({ reason: "invalid" });
    }
    const descriptorResponse = yield* http.get(`${url.origin}/.well-known/t3/environment`).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new SetupProfileError({ reason: "unreachable" })),
    );
    const descriptor = yield* descriptorResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => new SetupProfileError({ reason: "unreachable" })),
    );
    if (descriptor.environmentId !== binding.profile.ownerEnvironmentId)
      return yield* new SetupProfileError({ reason: "denied" });
    if (descriptor.capabilities.setupProfiles !== 1)
      return yield* new SetupProfileError({ reason: "unsupported" });
    const token = overrideToken ?? (yield* getToken(binding.profile.id));
    return yield* http
      .execute(
        HttpClientRequest.get(
          `${url.origin}/api/setup-profiles/${encodeURIComponent(binding.profile.id)}${suffix}`,
        ).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${token}`,
            "t3-setup-destination": environmentId,
            ...(suffix === "" && binding.profile.revision > 0
              ? { "if-none-match": `"${binding.profile.revision}"` }
              : {}),
          }),
        ),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => new SetupProfileError({ reason: "unreachable" })),
      );
  });
  const cacheRemote = Effect.fn("SetupProfiles.cacheRemote")(function* (
    binding: SetupProfileBinding,
    profile: SetupProfile,
    token?: string,
  ) {
    if (
      profile.id !== binding.profile.id ||
      profile.ownerEnvironmentId !== binding.profile.ownerEnvironmentId
    )
      return yield* new SetupProfileError({ reason: "denied" });
    yield* checked(profile);
    for (const skill of profile.skills)
      for (const file of skill.files) {
        const cached = yield* packages.read(file.digest).pipe(Effect.option);
        if (Option.isSome(cached)) {
          if (cached.value.length !== file.size)
            return yield* new SetupProfileError({ reason: "invalid" });
          continue;
        }
        const response = yield* request(
          binding,
          `/blobs/${file.digest}?revision=${profile.revision}`,
          token,
        );
        if (
          response.status !== 200 ||
          Number(response.headers["content-length"] ?? 0) > MAX_SETUP_PACKAGE_BYTES
        )
          return yield* new SetupProfileError({ reason: "invalid" });
        const bytes = new Uint8Array(
          yield* response.arrayBuffer.pipe(
            Effect.provideService(
              HttpIncomingMessage.MaxBodySize,
              ByteSize.bytes(MAX_SETUP_PACKAGE_BYTES),
            ),
            Effect.mapError(storageError),
          ),
        );
        if (bytes.length !== file.size) return yield* new SetupProfileError({ reason: "invalid" });
        yield* packages.put(bytes, file.digest);
      }
    const previous = yield* store.get(profile.id).pipe(
      Effect.catchTags({
        SetupProfileError: (error) =>
          error.reason === "not-found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (
      previous &&
      (previous.ownerEnvironmentId !== profile.ownerEnvironmentId ||
        previous.revision > profile.revision)
    )
      return yield* new SetupProfileError({ reason: "denied" });
    if (previous?.revision !== profile.revision)
      yield* store.publish(profile, previous?.revision ?? 0);
  });
  const resolveValues = Effect.fn("SetupProfiles.resolveValues")(function* (
    values: Readonly<Record<string, SetupValue>>,
  ) {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.kind === "literal") resolved[key] = value.value;
      else {
        const secret = yield* secrets.get(value.name).pipe(Effect.mapError(storageError));
        if (Option.isNone(secret)) return null;
        resolved[key] = new TextDecoder().decode(secret.value);
      }
    }
    return resolved;
  });
  const executableAvailable = Effect.fn("SetupProfiles.executableAvailable")(function* (
    command: string,
    env: Readonly<Record<string, string>>,
  ) {
    const platform = yield* HostProcess.Platform;
    const windows = platform === "win32";
    const roots =
      command.includes("/") || command.includes("\\")
        ? [""]
        : (env.PATH ?? processEnvironment.PATH ?? "").split(windows ? ";" : ":");
    const suffixes = windows
      ? ["", ...(processEnvironment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
    for (const root of roots)
      for (const suffix of suffixes) {
        const candidate = root ? path.join(root, command + suffix) : command + suffix;
        const stat = yield* fs.stat(candidate).pipe(Effect.option);
        if (
          Option.isSome(stat) &&
          stat.value.type === "File" &&
          (windows || (stat.value.mode & 0o111) !== 0)
        )
          return true;
      }
    return false;
  });
  const plan = Effect.fn("SetupProfiles.plan")(function* (binding: SetupProfileBinding) {
    const currentSettings = yield* settings.getSettings.pipe(Effect.mapError(storageError));
    const items: SetupItemStatus[] = [];
    const wanted: SetupFiles.SetupFile[] = [];
    const connections = new Map<ProviderInstanceId, ReadonlyArray<ResolvedSetupConnection>>();
    for (const instanceId of binding.instanceIds) {
      const instance = deriveProviderInstanceConfigMap(currentSettings)[instanceId];
      if (!instance) {
        items.push({
          instanceId,
          name: "Provider instance",
          kind: "mcp",
          status: "unsupported",
          message: "This provider instance no longer exists.",
        });
        continue;
      }
      const native = nativeSetupLayout(instance, home, path, processEnvironment);
      const ready: ResolvedSetupConnection[] = [];
      for (const c of binding.profile.connections) {
        if (!c.enabled || (c.drivers.length && !c.drivers.includes(instance.driver))) continue;
        const environment = yield* resolveValues(c.environment);
        const headers = yield* resolveValues(c.headers);
        const supported = native.mcpSupported;
        const needsSecret = environment === null || headers === null;
        const command = c.command?.startsWith("~/")
          ? path.join(home, c.command.slice(2))
          : c.command;
        const installed =
          !supported ||
          needsSecret ||
          c.transport === "http" ||
          (command !== undefined && (yield* executableAvailable(command, environment!)));
        items.push({
          instanceId,
          name: c.name,
          kind: "mcp",
          status: !supported
            ? "unsupported"
            : needsSecret
              ? "needs-secret"
              : !installed
                ? "missing-prerequisite"
                : "configured",
          message: !supported
            ? "Managed MCP injection is unavailable for this provider configuration."
            : needsSecret
              ? "Bind the required secret on this environment."
              : !installed
                ? `Install the executable ${command} on this environment.`
                : "Configured for new native sessions; tool invocation still needs verification.",
        });
        if (supported && !needsSecret && installed)
          ready.push({
            name: c.name,
            transport: c.transport,
            ...(command ? { command } : {}),
            args: c.args,
            ...(c.url ? { url: c.url } : {}),
            environment,
            headers,
          });
      }
      connections.set(instanceId, ready);
      for (const skill of binding.profile.skills) {
        if (skill.drivers.length && !skill.drivers.includes(instance.driver)) continue;
        items.push({
          name: skill.name,
          instanceId,
          kind: "skill",
          status: native.skillDirectory ? "configured" : "unsupported",
          message: native.skillDirectory
            ? "Native skill files installed; invocation still needs verification."
            : "Native skill installation is not supported for this provider.",
        });
        if (!native.skillDirectory) continue;
        for (const file of skill.files)
          wanted.push({
            path: path.join(native.skillDirectory, skill.name, ...file.path.split("/")),
            root: native.skillDirectory,
            digest: file.digest,
            executable: file.executable,
          });
      }
    }
    const key = yield* encodeJson([
      binding.profile,
      binding.instanceIds,
      Array.from(connections),
    ]).pipe(Effect.mapError(storageError));
    return { items, wanted, connections, key };
  });
  const activate = Effect.fn("SetupProfiles.activate")(
    function* (
      binding: SetupProfileBinding,
      reload: (ids: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void, SetupProfileError>,
      refreshed: (ids: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void>,
    ) {
      const { items, wanted, connections, key } = yield* plan(binding);
      if (key === appliedKey) {
        const conflicts = binding.detached ? [] : yield* files.inspect(binding.profile.id);
        yield* store.saveBinding({
          ...binding,
          conflicts: conflicts.slice(0, 100),
          error: conflicts.length
            ? "Local file conflicts require a resolution before this setup can activate."
            : null,
        });
        return;
      }
      const busy = yield* sql<{
        run_id: string;
      }>`SELECT run_id FROM orchestration_v2_projection_runs
      WHERE status IN ('preparing','queued','starting','running','waiting') LIMIT 1`.pipe(
        Effect.mapError(storageError),
      );
      if (busy.length) {
        yield* store.saveBinding({
          ...binding,
          observedRevision: binding.profile.revision,
          error: "Waiting for active work to finish before activating setup.",
        });
        return;
      }
      const released = yield* reload(affectedInstances(binding)).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      );
      if (!released) {
        yield* store.saveBinding({
          ...binding,
          error: "Waiting for native background work to finish before activating setup.",
        });
        return;
      }
      const conflicts = binding.detached ? [] : yield* files.apply(binding.profile.id, wanted);
      if (conflicts.length) {
        yield* store.saveBinding({
          ...binding,
          items,
          conflicts: conflicts.slice(0, 100),
          error: "Local file conflicts require a resolution before this setup can activate.",
        });
        return;
      }
      yield* runtime.replace(connections);
      yield* refreshed(binding.instanceIds);
      yield* store.saveBinding({
        ...binding,
        items,
        conflicts: [],
        appliedRevision: binding.profile.revision,
        lastApplied: {
          profileId: binding.profile.id,
          revision: binding.profile.revision,
          instanceIds: binding.instanceIds,
          detached: binding.detached ?? false,
        },
        observedRevision: binding.profile.revision,
        error: null,
      });
      appliedKey = key;
    },
    (effect) => runtime.stable(effect),
  );
  const restoreRuntime = Effect.fn("SetupProfiles.restoreRuntime")(
    function* () {
      const binding = yield* store.binding;
      const applied = lastApplied(binding);
      if (!binding || !applied || binding.pendingRemoval) return;
      const cached = yield* store.get(applied.profileId, applied.revision);
      const planned = yield* plan({
        ...binding,
        profile: cached,
        instanceIds: applied.instanceIds,
      });
      const conflicts = applied.detached ? [] : yield* files.apply(cached.id, planned.wanted);
      yield* runtime.replace(planned.connections);
      yield* store.saveBinding({
        ...binding,
        items: planned.items,
        conflicts: conflicts.slice(0, 100),
        error: conflicts.length
          ? "Local file conflicts require a resolution before this setup can activate."
          : binding.error,
      });
    },
    (effect) => lock.withPermits(1)(runtime.stable(effect)),
  );
  const reconcile = Effect.fn("SetupProfiles.reconcile")(
    function* (
      reload: Parameters<typeof activate>[1],
      refreshed: Parameters<typeof activate>[2] = () => Effect.void,
    ) {
      let binding = yield* store.binding;
      if (!binding) {
        yield* runtime.replace(new Map());
        return;
      }
      if (binding.pendingRemoval) {
        const removing = binding;
        return yield* runtime.stable(
          Effect.gen(function* () {
            const busy = yield* sql<{
              run_id: string;
            }>`SELECT run_id FROM orchestration_v2_projection_runs WHERE status IN ('preparing','queued','starting','running','waiting') LIMIT 1`.pipe(
              Effect.mapError(storageError),
            );
            if (busy.length) return;
            yield* reload(affectedInstances(removing));
            const conflicts = yield* files.detach(removing.profile.id, true);
            if (conflicts.length) {
              yield* store.saveBinding({
                ...removing,
                conflicts: conflicts.slice(0, 100),
                error: `Local file conflicts: ${conflicts.join("\n")}`,
              });
              return;
            }
            yield* refreshed(removing.instanceIds);
            yield* store.saveBinding(null);
            yield* runtime.replace(new Map());
            appliedKey = "";
            return;
          }),
        );
      }
      if (binding.enabled) {
        const previous = binding;
        const latest =
          binding.sourceUrl === null
            ? store.get(binding.profile.id)
            : request(binding, "").pipe(
                Effect.flatMap((response) =>
                  Effect.gen(function* () {
                    if (response.status === 304) return previous.profile;
                    if (response.status !== 200)
                      return yield* new SetupProfileError({
                        reason: response.status === 403 ? "denied" : "unreachable",
                      });
                    const json = yield* response.json.pipe(Effect.mapError(storageError));
                    return yield* decodeProfile(json).pipe(Effect.mapError(storageError));
                  }),
                ),
              );
        const result = yield* latest.pipe(
          Effect.match({
            onFailure: (error) => ({ profile: previous.profile, error: error.message }),
            onSuccess: (profile) => ({ profile, error: null }),
          }),
        );
        if (
          result.profile.id !== binding.profile.id ||
          result.profile.ownerEnvironmentId !== binding.profile.ownerEnvironmentId ||
          result.profile.revision < binding.profile.revision
        )
          return yield* new SetupProfileError({ reason: "denied" });
        if (result.error !== null) {
          yield* store.saveBinding({ ...binding, error: result.error });
          if (binding.appliedRevision && appliedKey === "") {
            const good = yield* store.get(binding.profile.id, binding.appliedRevision);
            yield* activate({ ...binding, profile: good, enabled: false }, reload, refreshed);
            yield* store.saveBinding({
              ...(yield* store.binding)!,
              profile: previous.profile,
              error: result.error,
            });
          }
          return;
        }
        yield* checked(result.profile);
        if (binding.sourceUrl !== null && result.profile.revision !== binding.profile.revision)
          yield* cacheRemote(binding, result.profile);
        binding = {
          ...binding,
          profile: result.profile,
          observedRevision: result.profile.revision,
        };
        yield* store.saveBinding(binding);
      }
      yield* activate(binding, reload, refreshed);
    },
    (effect) =>
      lock.withPermits(1)(
        effect.pipe(
          Effect.tapError((error) =>
            store.binding.pipe(
              Effect.flatMap((binding) =>
                binding ? store.saveBinding({ ...binding, error: error.message }) : Effect.void,
              ),
              Effect.ignore,
            ),
          ),
        ),
      ),
  );
  const command = Effect.fn("SetupProfiles.command")(
    function* (input: SetupProfileCommand) {
      switch (input.operation) {
        case "publish": {
          yield* checked(input.profile);
          const id = input.profile.id ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
          if (!validSetupName(id)) return yield* new SetupProfileError({ reason: "invalid" });
          if (
            input.profile.expectedRevision > 0 &&
            (yield* store.get(id)).ownerEnvironmentId !== environmentId
          )
            return yield* new SetupProfileError({ reason: "denied" });
          for (const skill of input.profile.skills)
            for (const file of skill.files) {
              const bytes = yield* packages.read(file.digest);
              if (bytes.length !== file.size)
                return yield* new SetupProfileError({ reason: "invalid" });
            }
          yield* store.publish(
            {
              id,
              ownerEnvironmentId: environmentId,
              name: input.profile.name,
              revision: input.profile.expectedRevision + 1,
              schemaVersion: 1,
              connections: input.profile.connections,
              skills: input.profile.skills,
              ...(input.profile.memoryScopes ? { memoryScopes: input.profile.memoryScopes } : {}),
              ...(input.profile.computerUse ? { computerUse: input.profile.computerUse } : {}),
            },
            input.profile.expectedRevision,
          );
          break;
        }
        case "apply": {
          const previous = yield* store.binding;
          if (previous?.pendingRemoval) return yield* new SetupProfileError({ reason: "conflict" });
          if (previous && !previous.detached && previous.profile.id !== input.profileId)
            return yield* new SetupProfileError({ reason: "conflict" });
          const profile = yield* store.get(input.profileId);
          yield* store.saveBinding({
            profile,
            sourceUrl: null,
            instanceIds: input.instanceIds,
            enabled: input.subscribe,
            observedRevision: profile.revision,
            appliedRevision: previous?.profile.id === profile.id ? previous.appliedRevision : 0,
            ...(lastApplied(previous) ? { lastApplied: lastApplied(previous)! } : {}),
            items: [],
            error: null,
          });
          appliedKey = "";
          break;
        }
        case "subscribe": {
          const previous = yield* store.binding;
          if (previous?.pendingRemoval) return yield* new SetupProfileError({ reason: "conflict" });
          if (previous && !previous.detached && previous.profile.id !== input.profileId)
            return yield* new SetupProfileError({ reason: "conflict" });
          const placeholder: SetupProfile = {
            id: input.profileId,
            ownerEnvironmentId: input.ownerEnvironmentId,
            name: "Subscribed setup",
            revision: 0,
            schemaVersion: 1,
            connections: [],
            skills: [],
          };
          const draft: SetupProfileBinding = {
            profile: placeholder,
            sourceUrl: input.sourceUrl,
            instanceIds: input.instanceIds,
            enabled: true,
            observedRevision: 0,
            appliedRevision: 0,
            items: [],
            error: null,
          };
          const response = yield* request(draft, "", input.token);
          if (response.status !== 200) return yield* new SetupProfileError({ reason: "denied" });
          const profile = yield* response.json.pipe(
            Effect.flatMap(decodeProfile),
            Effect.mapError(storageError),
          );
          yield* checked(profile);
          if (
            profile.id !== input.profileId ||
            profile.ownerEnvironmentId !== input.ownerEnvironmentId
          )
            return yield* new SetupProfileError({ reason: "denied" });
          yield* secrets
            .set(tokenName(input.profileId), Text.encode(input.token))
            .pipe(Effect.mapError(storageError));
          yield* store.saveBinding(
            previous && !previous.detached
              ? {
                  ...previous,
                  sourceUrl: input.sourceUrl,
                  instanceIds: input.instanceIds,
                  enabled: true,
                }
              : {
                  ...draft,
                  profile: { ...placeholder, name: profile.name },
                  observedRevision: profile.revision,
                  ...(lastApplied(previous) ? { lastApplied: lastApplied(previous)! } : {}),
                },
          );
          appliedKey = "";
          break;
        }
        case "pause": {
          const binding = yield* store.binding;
          if (binding) yield* store.saveBinding({ ...binding, enabled: !input.paused });
          break;
        }
        case "detach": {
          const binding = yield* store.binding;
          if (!binding) break;
          if (input.removeManaged)
            yield* store.saveBinding({
              ...binding,
              enabled: false,
              detached: true,
              sourceUrl: null,
              pendingRemoval: true,
            });
          else {
            const applied = lastApplied(binding);
            yield* files.detach(binding.profile.id, false);
            if (!applied) yield* store.saveBinding(null);
            else {
              const profile = yield* store.get(applied.profileId, applied.revision);
              yield* store.saveBinding({
                ...binding,
                profile,
                instanceIds: applied.instanceIds,
                appliedRevision: applied.revision,
                lastApplied: { ...applied, detached: true },
                enabled: false,
                detached: true,
                sourceUrl: null,
                conflicts: [],
                error: null,
              });
            }
          }
          yield* secrets.remove(tokenName(binding.profile.id)).pipe(Effect.mapError(storageError));
          break;
        }
        case "bind-secret": {
          const binding = yield* store.binding;
          if (
            !binding ||
            !binding.profile.connections.some((c) =>
              [...Object.values(c.environment), ...Object.values(c.headers)].some(
                (v) => v.kind === "secret" && v.name === input.name,
              ),
            )
          )
            return yield* new SetupProfileError({ reason: "denied" });
          yield* secrets
            .set(input.name, Text.encode(input.secret))
            .pipe(Effect.mapError(storageError));
          appliedKey = "";
          break;
        }
        case "resolve":
          yield* files.resolve(input.path, input.resolution);
          appliedKey = "";
          break;
        case "reconcile":
          appliedKey = "";
          break;
      }
      return yield* state;
    },
    (effect) => lock.withPermits(1)(effect),
  );
  const grant = Effect.fn("SetupProfiles.grant")(function* (
    input: typeof SetupProfileGrantInput.Type,
  ) {
    const profile = yield* store.get(input.profileId);
    if (profile.ownerEnvironmentId !== environmentId)
      return yield* new SetupProfileError({ reason: "denied" });
    const token = input.revoke
      ? null
      : yield* crypto.randomBytes(32).pipe(
          Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
          Effect.orDie,
        );
    yield* store.grant(
      input.profileId,
      input.destinationEnvironmentId,
      token === null ? null : yield* packages.digest(Text.encode(token)),
    );
    return { token };
  });
  const serve = Effect.fn("SetupProfiles.serve")(function* (input: {
    profileId: string;
    revision?: number;
    destinationId: string;
    token: string;
    digest?: string;
  }) {
    if (
      !input.token ||
      !(yield* store.authorize(
        input.profileId,
        input.destinationId,
        yield* packages.digest(Text.encode(input.token)),
      ))
    )
      return yield* new SetupProfileError({ reason: "denied" });
    const profile = yield* store.get(input.profileId, input.revision);
    if (input.digest === undefined) return profile;
    if (!profile.skills.some((s) => s.files.some((f) => f.digest === input.digest)))
      return yield* new SetupProfileError({ reason: "denied" });
    return yield* packages.read(input.digest);
  });
  return SetupProfiles.of({
    restoreRuntime: restoreRuntime(),
    changes: store.changes.pipe(Stream.mapEffect(() => state)),
    state,
    command,
    importSetup,
    grant,
    serve,
    reconcile,
  });
});

export const layer = Layer.effect(SetupProfiles, make);
