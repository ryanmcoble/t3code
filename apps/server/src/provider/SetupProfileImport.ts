import {
  SetupProfileError,
  type SetupProfileImportInput,
  type SetupMcpConnection,
  type SetupValue,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SetupPackages from "../setupProfiles/SetupPackages.ts";
import {
  validateSetupProfile,
  validSetupName,
  hasInlineCredential,
} from "../setupProfiles/validation.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { nativeSetupLayout } from "./setupProfileAdapter.ts";

const Text = new TextEncoder();
const storageError = (cause: unknown) => new SetupProfileError({ reason: "storage", cause });
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const nativeMcp = Schema.Struct({
  command: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  args: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  oauth: Schema.optional(Schema.Unknown),
  tools: Schema.optional(Schema.Array(Schema.String)),
});
const decodeNative = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      mcpServers: Schema.optional(Schema.Record(Schema.String, nativeMcp)),
      mcp: Schema.optional(Schema.Record(Schema.String, nativeMcp)),
    }),
  ),
);

const decodeCodexConnections = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        enabled: Schema.Boolean,
        auth_status: Schema.optional(Schema.String),
        transport: Schema.Struct({
          command: Schema.optional(Schema.String),
          args: Schema.optional(Schema.Array(Schema.String)),
          env: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
          url: Schema.optional(Schema.String),
          env_vars: Schema.optional(Schema.Array(Schema.String)),
          bearer_token_env_var: Schema.optional(Schema.NullOr(Schema.String)),
          http_headers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
          env_http_headers: Schema.optional(
            Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
          ),
          http_headers_helper: Schema.optional(Schema.Unknown),
        }),
      }),
    ),
  ),
);

export const makeSetupImporter = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const packages = yield* SetupPackages.SetupPackages;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const processEnvironment = yield* HostProcess.Environment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const importSetup = Effect.fn("SetupProfiles.importSetup")(function* (
    input: typeof SetupProfileImportInput.Type,
  ) {
    const current = yield* settings.getSettings.pipe(Effect.mapError(storageError));
    const instance = deriveProviderInstanceConfigMap(current)[input.instanceId];
    if (!instance) return yield* new SetupProfileError({ reason: "not-found" });
    const native = nativeSetupLayout(instance, home, path, processEnvironment);
    const connections: SetupMcpConnection[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const location of native.configFiles) {
      if (!(yield* fs.exists(location).pipe(Effect.mapError(storageError)))) continue;
      const config = yield* fs
        .readFileString(location)
        .pipe(Effect.flatMap(decodeNative), Effect.mapError(storageError));
      for (const [name, c] of Object.entries(config.mcpServers ?? config.mcp ?? {})) {
        if (name.startsWith("t3-code") || seen.has(name) || !validSetupName(name)) continue;
        seen.add(name);
        if (
          (c.oauth !== undefined && c.oauth !== false) ||
          c.type === "sse" ||
          (c.tools !== undefined && !c.tools.includes("*"))
        ) {
          warnings.push(
            `${name}: native OAuth, legacy SSE, or restricted tool filters need a supported native setup flow; this entry was excluded.`,
          );
          continue;
        }
        const capture = Effect.fn("SetupProfiles.captureSecrets")(function* (
          values: Readonly<Record<string, string>>,
        ) {
          const result: Record<string, SetupValue> = {};
          for (const [key, value] of Object.entries(values)) {
            const secretName = `setup-${(yield* packages.digest(Text.encode(`${input.instanceId}:${name}:${key}`))).slice(0, 32)}`;
            yield* secrets.set(secretName, Text.encode(value)).pipe(Effect.mapError(storageError));
            result[key] = { kind: "secret", name: secretName };
          }
          return result;
        });
        const args =
          typeof c.command === "string" ? (c.args ?? []) : (c.command?.slice(1) ?? c.args ?? []);
        if (hasInlineCredential(args)) {
          warnings.push(
            `${name}: inline credential arguments require manual classification; use environment or header secret references.`,
          );
          continue;
        }
        connections.push({
          name,
          transport: c.url ? "http" : "stdio",
          ...(c.command
            ? { command: typeof c.command === "string" ? c.command : c.command[0] }
            : {}),
          args,
          ...(c.url ? { url: c.url } : {}),
          environment: yield* capture(c.env ?? c.environment ?? {}),
          headers: yield* capture(c.headers ?? {}),
          drivers: [],
          enabled: c.enabled ?? true,
        });
      }
    }
    if (instance.driver === "codex") {
      const config = isRecord(instance.config) ? instance.config : {};
      const configuredHome = typeof config.homePath === "string" ? config.homePath : "";
      const shadowHome = typeof config.shadowHomePath === "string" ? config.shadowHomePath : "";
      const selectedHome = shadowHome || configuredHome;
      const resolvedHome = selectedHome.startsWith("~/")
        ? path.join(home, selectedHome.slice(2))
        : selectedHome;
      const output = yield* runner
        .run({
          command:
            typeof config.binaryPath === "string" && config.binaryPath
              ? config.binaryPath
              : "codex",
          args: ["mcp", "list", "--json"],
          timeout: "15 seconds",
          maxOutputBytes: 2 * 1024 * 1024,
          env: { ...processEnvironment, ...(resolvedHome ? { CODEX_HOME: resolvedHome } : {}) },
        })
        .pipe(Effect.mapError(storageError));
      if (output.code !== 0) return yield* new SetupProfileError({ reason: "unsupported" });
      const entries = yield* decodeCodexConnections(output.stdout).pipe(
        Effect.mapError(storageError),
      );
      for (const entry of entries) {
        if (entry.name.startsWith("t3-code")) continue;
        if (hasInlineCredential(entry.transport.args ?? [])) {
          warnings.push(
            `${entry.name}: inline credential arguments require manual classification; use environment or header secret references.`,
          );
          continue;
        }
        if (
          entry.auth_status?.replaceAll("_", "").includes("oauth") ||
          entry.transport.http_headers_helper
        ) {
          warnings.push(
            `${entry.name}: OAuth and dynamic header helpers require native sign-in; this entry was excluded.`,
          );
          continue;
        }
        const captureValue = Effect.fn("SetupProfiles.captureNativeValue")(function* (
          key: string,
          value: string | undefined,
        ) {
          const name = `setup-${(yield* packages.digest(Text.encode(`${input.instanceId}:${entry.name}:${key}`))).slice(0, 32)}`;
          if (value === undefined) {
            yield* secrets.remove(name).pipe(Effect.mapError(storageError));
            warnings.push(`${entry.name}: bind the ${key} credential reference before activation.`);
          } else yield* secrets.set(name, Text.encode(value)).pipe(Effect.mapError(storageError));
          return { kind: "secret" as const, name };
        });
        const inheritedValue = (name: string) => {
          const configured = instance.environment?.find((e) => e.name === name);
          return configured === undefined
            ? processEnvironment[name]
            : typeof configured.value === "string"
              ? configured.value
              : undefined;
        };
        const environment: Record<string, SetupValue> = {};
        for (const [name, value] of Object.entries(entry.transport.env ?? {})) {
          const secretName = `setup-${(yield* packages.digest(Text.encode(`${input.instanceId}:${entry.name}:${name}`))).slice(0, 32)}`;
          yield* secrets.set(secretName, Text.encode(value)).pipe(Effect.mapError(storageError));
          environment[name] = { kind: "secret", name: secretName };
        }
        for (const name of entry.transport.env_vars ?? [])
          if (environment[name] === undefined)
            environment[name] = yield* captureValue(`env:${name}`, inheritedValue(name));
        const headers: Record<string, SetupValue> = {};
        for (const [name, value] of Object.entries(entry.transport.http_headers ?? {}))
          headers[name] = yield* captureValue(`header:${name}`, value);
        for (const [name, variable] of Object.entries(entry.transport.env_http_headers ?? {}))
          headers[name] = yield* captureValue(`header:${name}`, inheritedValue(variable));
        if (entry.transport.bearer_token_env_var) {
          const token = inheritedValue(entry.transport.bearer_token_env_var);
          headers.Authorization = yield* captureValue(
            "header:Authorization",
            token === undefined ? undefined : `Bearer ${token}`,
          );
        }
        connections.push({
          name: entry.name,
          transport: entry.transport.url ? "http" : "stdio",
          args: entry.transport.args ?? [],
          ...(entry.transport.command ? { command: entry.transport.command } : {}),
          ...(entry.transport.url ? { url: entry.transport.url } : {}),
          environment,
          headers,
          drivers: [],
          enabled: entry.enabled,
        });
      }
    }
    const skills = yield* Effect.forEach(input.skillPaths, (s) =>
      packages.importSkill(s.startsWith("~/") ? path.join(home, s.slice(2)) : s),
    );
    if (connections.some((c) => c.args.length > 0))
      warnings.push(
        "Review imported command arguments for credentials before publishing. Use environment or header secret references for credential values.",
      );
    if (connections.some((c) => Object.keys(c.environment).length || Object.keys(c.headers).length))
      warnings.push(
        "Imported credential values remain in this environment's secret store. Bind the named secrets separately on other environments.",
      );
    yield* Effect.try({
      try: () => validateSetupProfile({ connections, skills }),
      catch: () => new SetupProfileError({ reason: "invalid" }),
    });
    return { connections, skills, warnings };
  });
  return importSetup;
});
