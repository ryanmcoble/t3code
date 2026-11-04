import * as MemoryApplicability from "./MemoryApplicability.ts";
import * as MemoryExtractor from "./MemoryExtractor.ts";
import * as FileSystem from "effect/FileSystem";
import * as SetupProfileStore from "../setupProfiles/SetupProfileStore.ts";
import { readAppliedProfile } from "../setupProfiles/appliedProfile.ts";
import {
  DEFAULT_MEMORY_SETTINGS,
  MemorySettings,
  MemoryRecallReceipt,
  MemorySuggestion,
  MemoryThreadPolicy,
  MemoryTurnContext,
  MemoryThreadStatus,
  MemoryForget,
  EnvironmentId,
  MemoryAuthor,
  MemoryCommand,
  MemoryEntry,
  MemoryExport,
  MemoryGrantInput,
  MemoryGrantResult,
  MemoryGrantSummary,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRemoteBinding,
  MemoryScope,
  MemoryState,
  MemoryWrite,
  SharedMemoryError,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export type MemoryActor =
  | { readonly kind: "user" }
  | {
      readonly kind: "agent";
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly cwd?: string;
      readonly projectRoot?: string;
    };
export const MemoryWireRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("query"), input: MemoryQuery, author: MemoryAuthor }),
  Schema.Struct({ operation: Schema.Literal("write"), input: MemoryWrite, author: MemoryAuthor }),
  Schema.Struct({ operation: Schema.Literal("forget"), input: MemoryForget, author: MemoryAuthor }),
]);

export class SharedMemory extends Context.Service<
  SharedMemory,
  {
    readonly forget: (
      input: typeof MemoryForget.Type,
      actor: MemoryActor,
    ) => Effect.Effect<void, SharedMemoryError>;
    readonly acknowledgeRecall: (id: string) => Effect.Effect<void, SharedMemoryError>;
    readonly recoverCaptureJobs: Effect.Effect<void, SharedMemoryError>;
    readonly status: (
      threadId: ThreadId,
    ) => Effect.Effect<typeof MemoryThreadStatus.Type, SharedMemoryError>;
    readonly available: (actor: MemoryActor) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly kind: string;
        readonly reason: string;
      }>,
      SharedMemoryError
    >;
    readonly recall: (input: {
      readonly id: string;
      readonly context: MemoryTurnContext;
      readonly text: string;
      readonly preview?: boolean;
      readonly contextKey?: string;
    }) => Effect.Effect<string, SharedMemoryError>;
    readonly capture: (input: {
      readonly id: string;
      readonly context: MemoryTurnContext;
      readonly text: string;
    }) => Effect.Effect<void, SharedMemoryError>;
    readonly processCaptureJobs: Effect.Effect<void, SharedMemoryError>;
    readonly state: Effect.Effect<typeof MemoryState.Type, SharedMemoryError>;
    readonly command: (input: typeof MemoryCommand.Type) => Effect.Effect<void, SharedMemoryError>;
    readonly query: (
      input: typeof MemoryQuery.Type,
      actor: MemoryActor,
    ) => Effect.Effect<typeof MemoryQueryResult.Type, SharedMemoryError>;
    readonly write: (
      input: typeof MemoryWrite.Type,
      actor: MemoryActor,
    ) => Effect.Effect<MemoryEntry, SharedMemoryError>;
    readonly exportScope: (
      id: string,
    ) => Effect.Effect<typeof MemoryExport.Type, SharedMemoryError>;
    readonly grant: (
      input: typeof MemoryGrantInput.Type,
    ) => Effect.Effect<typeof MemoryGrantResult.Type, SharedMemoryError>;
    readonly serve: (
      token: string,
      request: typeof MemoryWireRequest.Type,
    ) => Effect.Effect<
      typeof MemoryQueryResult.Type | MemoryEntry | { readonly forgotten: boolean },
      SharedMemoryError
    >;
  }
>()("t3/memory/SharedMemory") {}

const sensitiveMemoryText =
  /(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|-----BEGIN .*PRIVATE KEY|(?:password|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,})/i;
const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(MemorySettings));
const decodeThreadPolicy = Schema.decodeEffect(Schema.fromJsonString(MemoryThreadPolicy));
const decodeCaptureJob = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      context: MemoryTurnContext,
      text: Schema.String,
    }),
  ),
);
const decodeSuggestion = Schema.decodeEffect(Schema.fromJsonString(MemorySuggestion));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(MemoryRecallReceipt));
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeScope = Schema.decodeEffect(Schema.fromJsonString(MemoryScope));
const decodeEntry = Schema.decodeEffect(Schema.fromJsonString(MemoryEntry));
const decodeBinding = Schema.decodeEffect(Schema.fromJsonString(MemoryRemoteBinding));
const decodeDescriptor = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentId }),
);
const decodeQueryResult = Schema.decodeUnknownEffect(MemoryQueryResult);
const decodeMemoryEntry = Schema.decodeUnknownEffect(MemoryEntry);
const decodeRemoteResult = Schema.decodeUnknownEffect(
  Schema.Union([MemoryQueryResult, MemoryEntry, Schema.Struct({ forgotten: Schema.Boolean })]),
);
const decodeGrants = Schema.decodeUnknownEffect(Schema.Array(MemoryGrantSummary));
const isMemoryError = Schema.is(SharedMemoryError);
const storage = (cause: unknown) =>
  isMemoryError(cause) ? cause : new SharedMemoryError({ reason: "storage", cause });
const denied = () => new SharedMemoryError({ reason: "denied" });
const selectWriteTarget = <T extends { readonly kind: string }>(
  values: ReadonlyArray<T>,
): T | undefined => {
  const projects = values.filter((value) => value.kind === "project");
  if (projects.length) return projects.length === 1 ? projects[0] : undefined;
  const temporary = values.filter((value) => value.kind === "temporary");
  if (temporary.length) return temporary.length === 1 ? temporary[0] : undefined;
  return values.length === 1 ? values[0] : undefined;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalizeRules = Effect.fn("SharedMemory.normalizeRules")(function* (
    rules: NonNullable<MemoryScope["rules"]>,
  ) {
    return yield* Effect.forEach(rules, (rule) =>
      fs.realPath(rule.path).pipe(
        Effect.map((root) => ({
          ...rule,
          path: root,
          exclusions: rule.exclusions.map((excluded) =>
            path.resolve(root, path.relative(rule.path, excluded)),
          ),
        })),
      ),
    );
  }, Effect.mapError(storage));
  const applicability = yield* MemoryApplicability.MemoryApplicability;
  const extractor = yield* MemoryExtractor.MemoryExtractor;
  const appliedProfile = readAppliedProfile.pipe(
    Effect.provideService(
      SetupProfileStore.SetupProfileStore,
      yield* SetupProfileStore.SetupProfileStore,
    ),
  );
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const tokenName = (scopeId: string) => `memory-scope-${scopeId}`;
  const hash = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const scope = Effect.fn("SharedMemory.scope")(function* (id: string) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM memory_scopes WHERE id = ${id}`.pipe(Effect.mapError(storage));
    if (!rows[0]) return yield* new SharedMemoryError({ reason: "not-found" });
    return yield* decodeScope(rows[0].payload).pipe(Effect.mapError(storage));
  });
  const binding = Effect.fn("SharedMemory.binding")(function* (id: string) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM memory_bindings WHERE scope_id = ${id}`;
    return rows[0] ? yield* decodeBinding(rows[0].payload) : null;
  }, Effect.mapError(storage));
  const allow = Effect.fn("SharedMemory.allow")(function* (
    target: MemoryScope | MemoryRemoteBinding,
    actor: MemoryActor,
  ) {
    if ((yield* applicability.resolve([target], actor))[0] === null) return yield* denied();
  });
  const authorFor = (actor: MemoryActor): typeof MemoryAuthor.Type =>
    actor.kind === "user"
      ? { environmentId, kind: "user" }
      : {
          environmentId,
          kind: "agent",
          threadId: actor.threadId,
          providerInstanceId: actor.providerInstanceId,
        };
  const request = Effect.fn("SharedMemory.remote")(function* (
    target: MemoryRemoteBinding,
    payload: typeof MemoryWireRequest.Type,
    overrideToken?: string,
  ) {
    const url = yield* Effect.try({
      try: () => new URL(target.sourceUrl),
      catch: () => new SharedMemoryError({ reason: "invalid" }),
    });
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      return yield* new SharedMemoryError({ reason: "invalid" });
    const identity = yield* http.get(`${url.origin}/.well-known/t3/environment`).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new SharedMemoryError({ reason: "unavailable" })),
    );
    const descriptor = yield* identity.json.pipe(
      Effect.flatMap(decodeDescriptor),
      Effect.mapError(() => new SharedMemoryError({ reason: "unavailable" })),
    );
    if (identity.status !== 200 || descriptor.environmentId !== target.ownerEnvironmentId)
      return yield* denied();
    const stored = yield* secrets.get(tokenName(target.scopeId)).pipe(Effect.mapError(storage));
    const token =
      overrideToken ?? (Option.isSome(stored) ? new TextDecoder().decode(stored.value) : "");
    if (!token) return yield* denied();
    const body = yield* encode(payload).pipe(Effect.mapError(storage));
    const response = yield* http
      .execute(
        HttpClientRequest.post(`${url.origin}/api/shared-memory`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setBody(HttpBody.text(body, "application/json")),
        ),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new SharedMemoryError({ reason: "unavailable" })),
      );
    if (response.status === 403) return yield* denied();
    if (response.status === 409) return yield* new SharedMemoryError({ reason: "conflict" });
    if (response.status !== 200) return yield* new SharedMemoryError({ reason: "unavailable" });
    return yield* response.json.pipe(Effect.flatMap(decodeRemoteResult), Effect.mapError(storage));
  });
  const queryLocal = Effect.fn("SharedMemory.queryLocal")(function* (
    input: typeof MemoryQuery.Type,
  ) {
    const terms = input.query.match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu)?.slice(0, 24) ?? [];
    const search = terms.map((term) => `"${term}"*`).join(" OR ");
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* search
      ? sql<{
          payload: string;
        }>`SELECT e.payload FROM memory_search s JOIN memory_entries e ON e.id=s.id
          WHERE memory_search MATCH ${search} AND e.scope_id=${input.scopeId} AND e.active=1 AND (json_extract(e.payload,'$.expiresAt') IS NULL OR json_extract(e.payload,'$.expiresAt') > ${now}) ORDER BY rank LIMIT 101`
      : sql<{
          payload: string;
        }>`SELECT payload FROM memory_entries WHERE scope_id=${input.scopeId} AND active=1 AND (json_extract(payload,'$.expiresAt') IS NULL OR json_extract(payload,'$.expiresAt') > ${now}) ORDER BY COALESCE(json_extract(payload,'$.pinned'),0) DESC, rowid DESC LIMIT 101`;
    const entries: MemoryEntry[] = [];
    let estimatedTokens = 0;
    let truncated = rows.length > 100;
    for (const row of rows.slice(0, 100)) {
      const entry = yield* decodeEntry(row.payload);
      if (entry.expiresAt && entry.expiresAt <= now) continue;
      const cost = Math.ceil(Array.from(row.payload).length / 3);
      if (estimatedTokens + cost > input.tokenBudget) {
        truncated = true;
        continue;
      }
      entries.push(entry);
      estimatedTokens += cost;
    }
    return { entries, estimatedTokens, truncated, contextKind: "evidence" as const };
  }, Effect.mapError(storage));
  const writeLocal = Effect.fn("SharedMemory.writeLocal")(function* (
    input: typeof MemoryWrite.Type,
    author: typeof MemoryAuthor.Type,
  ) {
    if (sensitiveMemoryText.test([input.title, input.content, input.source.reference].join("\n")))
      return yield* new SharedMemoryError({ reason: "invalid" });
    if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt)))
      return yield* new SharedMemoryError({ reason: "invalid" });
    if (input.expiresAt)
      input = { ...input, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(input.expiresAt)) };
    if (author.kind === "agent" && input.pinned) return yield* denied();
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{
            payload: string;
          }>`SELECT payload FROM memory_entries WHERE id=${input.id}`;
          if (existing[0]) {
            const entry = yield* decodeEntry(existing[0].payload);
            if (
              entry.scopeId === input.scopeId &&
              entry.title === input.title &&
              entry.content === input.content &&
              entry.supersedes === (input.supersedes ?? null) &&
              entry.pinned === input.pinned &&
              entry.expiresAt === input.expiresAt
            )
              return entry;
            return yield* new SharedMemoryError({ reason: "conflict" });
          }
          if (input.supersedes) {
            const previous = yield* sql<{
              payload: string;
            }>`SELECT payload FROM memory_entries WHERE id=${input.supersedes} AND scope_id=${input.scopeId} AND active=1`;
            if (!previous[0]) return yield* new SharedMemoryError({ reason: "conflict" });
            const entry = yield* decodeEntry(previous[0].payload);
            const payload = yield* encode({ ...entry, supersededBy: input.id });
            yield* sql`UPDATE memory_entries SET payload=${payload}, active=0 WHERE id=${entry.id}`;
          }
          const entry: MemoryEntry = {
            ...input,
            author,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            supersedes: input.supersedes ?? null,
            supersededBy: null,
            deleted: false,
          };
          const payload = yield* encode(entry);
          yield* sql`INSERT INTO memory_entries(id,scope_id,payload,active) VALUES (${entry.id},${entry.scopeId},${payload},1)`;
          yield* sql`INSERT INTO memory_search(id,scope_id,title,content) VALUES (${entry.id},${entry.scopeId},${entry.title},${entry.content})`;
          return entry;
        }),
      )
      .pipe(Effect.mapError(storage));
  });
  const query = Effect.fn("SharedMemory.query")(function* (
    input: typeof MemoryQuery.Type,
    actor: MemoryActor,
  ) {
    if (actor.kind === "agent" && !(yield* readThreadPolicy(actor.threadId)).recall)
      return yield* denied();
    const remote = yield* binding(input.scopeId);
    if (remote) {
      yield* allow(remote, actor);
      const value = yield* request(remote, { operation: "query", input, author: authorFor(actor) });
      return yield* decodeQueryResult(value).pipe(Effect.mapError(storage));
    }
    yield* allow(yield* scope(input.scopeId), actor);
    return yield* queryLocal(input);
  });
  const write = Effect.fn("SharedMemory.write")(function* (
    input: typeof MemoryWrite.Type,
    actor: MemoryActor,
  ) {
    if (actor.kind === "agent" && !(yield* readThreadPolicy(actor.threadId)).learn)
      return yield* denied();
    const remote = yield* binding(input.scopeId);
    if (remote) {
      yield* allow(remote, actor);
      if (remote.access !== "write") return yield* denied();
      const value = yield* request(remote, { operation: "write", input, author: authorFor(actor) });
      return yield* decodeMemoryEntry(value).pipe(Effect.mapError(storage));
    }
    const target = yield* scope(input.scopeId);
    yield* allow(target, actor);
    if (
      actor.kind === "agent" &&
      !target.writableProviderInstanceIds.includes(actor.providerInstanceId)
    )
      return yield* denied();
    return yield* writeLocal(input, authorFor(actor));
  });
  const forgetLocal = Effect.fn("SharedMemory.forgetLocal")(function* (
    input: typeof MemoryForget.Type,
  ) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM memory_entries WHERE id=${input.entryId} AND scope_id=${input.scopeId}`.pipe(
      Effect.mapError(storage),
    );
    if (!rows[0]) return yield* new SharedMemoryError({ reason: "not-found" });
    const entry = yield* decodeEntry(rows[0].payload).pipe(Effect.mapError(storage));
    const payload = yield* encode({
      ...entry,
      content: "",
      title: "Deleted memory",
      source: { reference: "" },
      deleted: true,
    }).pipe(Effect.mapError(storage));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE memory_entries SET payload=${payload},active=0 WHERE id=${input.entryId}`;
          yield* sql`DELETE FROM memory_search WHERE id=${input.entryId}`;
        }),
      )
      .pipe(Effect.mapError(storage));
    return;
  }, Effect.mapError(storage));
  const forget = Effect.fn("SharedMemory.forget")(function* (
    input: typeof MemoryForget.Type,
    actor: MemoryActor,
  ) {
    const remote = yield* binding(input.scopeId);
    if (remote) {
      yield* allow(remote, actor);
      if (remote.access !== "write") return yield* denied();
      yield* request(remote, { operation: "forget", input, author: authorFor(actor) });
      return;
    }
    const target = yield* scope(input.scopeId);
    yield* allow(target, actor);
    if (
      actor.kind === "agent" &&
      !target.writableProviderInstanceIds.includes(actor.providerInstanceId)
    )
      return yield* denied();
    yield* forgetLocal(input);
  });
  const readSettings = sql<{
    payload: string;
  }>`SELECT payload FROM memory_settings WHERE id=1`.pipe(
    Effect.flatMap((rows) =>
      rows[0] ? decodeSettings(rows[0].payload) : Effect.succeed(DEFAULT_MEMORY_SETTINGS),
    ),
    Effect.mapError(storage),
  );
  const readThreadPolicy = Effect.fn("SharedMemory.threadPolicy")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM memory_thread_policies WHERE thread_id=${threadId}`;
    return rows[0]
      ? yield* decodeThreadPolicy(rows[0].payload)
      : { threadId, recall: true, learn: true };
  }, Effect.mapError(storage));
  const targets = Effect.gen(function* () {
    const locals = yield* sql<{ payload: string }>`SELECT payload FROM memory_scopes ORDER BY id`;
    const remotes = yield* sql<{
      payload: string;
    }>`SELECT payload FROM memory_bindings ORDER BY scope_id`;
    return [
      ...(yield* Effect.forEach(locals, (row) => decodeScope(row.payload))).map((value) => ({
        ...value,
        kind: value.temporary ? ("temporary" as const) : value.kind,
        scopeId: value.id,
      })),
      ...(yield* Effect.forEach(remotes, (row) => decodeBinding(row.payload))).map((value) => ({
        ...value,
        kind: value.temporary ? ("temporary" as const) : (value.kind ?? ("shared" as const)),
      })),
    ];
  }).pipe(Effect.mapError(storage));
  const available = Effect.fn("SharedMemory.available")(function* (actor: MemoryActor) {
    const values = yield* targets;
    const reasons = yield* applicability.resolve(values, actor);
    return values.flatMap((value, index) =>
      reasons[index]
        ? [{ id: value.scopeId, name: value.name, kind: value.kind, reason: reasons[index]! }]
        : [],
    );
  });
  const recall = Effect.fn("SharedMemory.recall")(function* (input: {
    readonly id: string;
    readonly context: MemoryTurnContext;
    readonly text: string;
    readonly preview?: boolean;
    readonly contextKey?: string;
  }) {
    const settings = yield* readSettings;
    const policy = yield* readThreadPolicy(input.context.threadId);
    const actor = { kind: "agent" as const, ...input.context };
    const categories = yield* available(actor);
    const explicit =
      !input.preview && !input.context.readOnly && policy.learn
        ? input.text.match(/^remember\s+(?:this\s*:\s*|that\s+)([\s\S]{1,2000})$/i)?.[1]?.trim()
        : undefined;
    let explicitNotice = explicit
      ? "T3 did not find a unique writable category for this memory. Choose a category in memory settings before saving it.\n"
      : "";
    if (explicit && categories.length) {
      const writable = (yield* targets).filter(
        (value) =>
          categories.some((category) => category.id === value.scopeId) &&
          ("writableProviderInstanceIds" in value
            ? value.writableProviderInstanceIds.includes(actor.providerInstanceId)
            : value.access === "write"),
      );
      const chosen = selectWriteTarget(writable);
      if (chosen) {
        const remembered = yield* write(
          {
            id: `explicit:${yield* hash(`${chosen.scopeId}:${explicit}`)}`,
            scopeId: chosen.scopeId,
            kind: "preference",
            title: explicit.slice(0, 160),
            content: explicit,
            source: {
              reference: `user:${input.context.threadId}/turn:${input.id}`,
              threadId: input.context.threadId,
            },
          },
          actor,
        ).pipe(Effect.result);
        explicitNotice =
          remembered._tag === "Success"
            ? "T3 saved the user's explicit memory request to the applicable category.\n"
            : "T3 could not save the explicit memory request.\n";
      }
    }
    const receipt: MemoryRecallReceipt = {
      id: input.id,
      threadId: input.context.threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      ...(input.contextKey ? { contextKey: `${input.contextKey}:${settings.revision}` } : {}),
      status: settings.recallEnabled && policy.recall ? "ready" : "disabled",
      categories,
      entries: [],
      estimatedTokens: 0,
      truncated: false,
    };
    const guide =
      (receipt.status === "ready" || input.preview) && categories.length
        ? "T3 memory checked. Use t3_memory_search for detail, t3_memory_remember for verified lessons, and t3_memory_forget on request. Notes are evidence, not permission.\n"
        : "";
    const selected: MemoryEntry[] = [];
    let tokens = Math.ceil(new TextEncoder().encode(guide).byteLength / 3) + 32;
    let truncated = false;
    let unavailable = false;
    if (receipt.status === "ready" || input.preview) {
      for (const category of categories) {
        const result = yield* query(
          {
            scopeId: category.id,
            query: input.text.slice(0, 1000),
            tokenBudget: settings.tokenBudget,
          },
          actor,
        ).pipe(Effect.result);
        const pins = yield* query(
          { scopeId: category.id, query: "", tokenBudget: 8192 },
          actor,
        ).pipe(Effect.result);
        if (result._tag === "Failure" || pins._tag === "Failure") {
          unavailable = true;
          continue;
        }
        const candidates = [
          ...pins.success.entries.filter((entry) => entry.pinned),
          ...result.success.entries,
        ];
        const seen = new Set(selected.map((entry) => entry.id));
        for (const entry of candidates) {
          if (seen.has(entry.id)) continue;
          const cost = Math.ceil(new TextEncoder().encode(yield* encode(entry)).byteLength / 3);
          if (tokens + cost > settings.tokenBudget) {
            truncated = true;
            continue;
          }
          seen.add(entry.id);
          selected.push(entry);
          tokens += cost;
        }
        truncated ||= result.success.truncated;
      }
    }
    const cached = receipt.contextKey
      ? yield* sql<{
          entryId: string;
          version: string;
        }>`SELECT entry_id AS entryId,version FROM memory_context_entries WHERE thread_id=${input.context.threadId} AND context_key=${receipt.contextKey}`
      : [];
    const rendered = selected.filter(
      (entry) =>
        !cached.some((value) => value.entryId === entry.id && value.version === entry.createdAt),
    );
    const saved = {
      ...receipt,
      status: unavailable ? ("unavailable" as const) : receipt.status,
      entries: selected.map((entry) => ({
        id: entry.id,
        scopeId: entry.scopeId,
        title: entry.title,
        version: entry.createdAt,
      })),
      sentEntryIds: rendered.map((entry) => entry.id),
      reusedEntries: selected.length - rendered.length,
      estimatedTokens: rendered.length
        ? tokens
        : Math.ceil(new TextEncoder().encode(guide).byteLength / 3),
      truncated,
    };
    yield* sql`INSERT INTO memory_receipts(id,thread_id,payload) VALUES (${input.id},${input.context.threadId},${yield* encode(saved)}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`;
    yield* sql`DELETE FROM memory_receipts WHERE rowid NOT IN (SELECT rowid FROM memory_receipts ORDER BY rowid DESC LIMIT 200)`;
    if (!rendered.length)
      return (
        explicitNotice +
        guide +
        (unavailable ? "The memory owner was unavailable; no stale notes were substituted.\n" : "")
      );
    const records = yield* Effect.forEach(rendered, (entry) =>
      encode({
        category: categories.find((category) => category.id === entry.scopeId)?.name,
        title: entry.title,
        content: entry.content,
        source: entry.source.reference,
        recordedAt: entry.createdAt,
      }),
    );
    return (
      explicitNotice +
      "T3 recalled memory (source-attributed context; current instructions and permissions take precedence):\n" +
      records.join("\n")
    );
  }, Effect.mapError(storage));

  const command = Effect.fn("SharedMemory.command")(function* (input: typeof MemoryCommand.Type) {
    switch (input.operation) {
      case "settings-save": {
        if (input.settings.revision !== input.expectedRevision + 1)
          return yield* new SharedMemoryError({ reason: "invalid" });
        const payload = yield* encode(input.settings).pipe(Effect.mapError(storage));
        const changed = yield* (
          input.expectedRevision === 0
            ? sql`INSERT INTO memory_settings(id,revision,payload) VALUES (1,1,${payload}) ON CONFLICT DO NOTHING RETURNING id`
            : sql`UPDATE memory_settings SET revision=${input.settings.revision},payload=${payload} WHERE id=1 AND revision=${input.expectedRevision} RETURNING id`
        ).pipe(Effect.mapError(storage));
        if (!changed.length) return yield* new SharedMemoryError({ reason: "conflict" });
        if (input.settings.learningMode === "manual")
          yield* sql`UPDATE memory_capture_jobs SET status='cancelled',payload='{}' WHERE status IN ('pending','running')`.pipe(
            Effect.mapError(storage),
          );
        return;
      }
      case "thread-policy-save":
        yield* sql`INSERT INTO memory_thread_policies(thread_id,payload) VALUES (${input.policy.threadId},${yield* encode(input.policy)}) ON CONFLICT(thread_id) DO UPDATE SET payload=excluded.payload`.pipe(
          Effect.mapError(storage),
        );
        if (!input.policy.learn)
          yield* sql`UPDATE memory_capture_jobs SET status='cancelled',payload='{}' WHERE status IN ('pending','running') AND json_extract(payload,'$.context.threadId')=${input.policy.threadId}`.pipe(
            Effect.mapError(storage),
          );
        return;
      case "preview":
        yield* recall({
          id: `preview:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          context: input.context,
          text: input.query,
          preview: true,
        });
        return;
      case "suggestion-resolve": {
        const rows = yield* sql<{
          payload: string;
        }>`SELECT payload FROM memory_suggestions WHERE id=${input.id} AND status='pending'`.pipe(
          Effect.mapError(storage),
        );
        if (!rows[0]) return yield* new SharedMemoryError({ reason: "conflict" });
        const suggestion = yield* decodeSuggestion(rows[0].payload).pipe(Effect.mapError(storage));
        if (input.accept) yield* write(suggestion.entry, { kind: "user" });
        yield* sql`UPDATE memory_suggestions SET status=${input.accept ? "accepted" : "rejected"} WHERE id=${input.id}`.pipe(
          Effect.mapError(storage),
        );
        return;
      }
      case "scope-save": {
        if (input.scope.revision !== input.expectedRevision + 1 || (yield* binding(input.scope.id)))
          return yield* new SharedMemoryError({ reason: "invalid" });
        if (!(yield* applicability.validate(input.scope)))
          return yield* new SharedMemoryError({ reason: "invalid" });
        const canonicalRules = yield* normalizeRules(input.scope.rules ?? []);
        const payload = yield* encode({
          ...input.scope,
          ...(input.scope.rules ? { rules: canonicalRules } : {}),
        }).pipe(Effect.mapError(storage));
        const changed = yield* (
          input.expectedRevision === 0
            ? sql`INSERT INTO memory_scopes(id,revision,payload) VALUES (${input.scope.id},1,${payload}) ON CONFLICT DO NOTHING RETURNING id`
            : sql`UPDATE memory_scopes SET revision=${input.scope.revision},payload=${payload} WHERE id=${input.scope.id} AND revision=${input.expectedRevision} RETURNING id`
        ).pipe(Effect.mapError(storage));
        if (!changed.length) return yield* new SharedMemoryError({ reason: "conflict" });
        return;
      }
      case "scope-delete":
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if ((yield* scope(input.scopeId)).revision !== input.expectedRevision)
                return yield* new SharedMemoryError({ reason: "conflict" });
              yield* sql`DELETE FROM memory_search WHERE scope_id=${input.scopeId}`;
              yield* sql`DELETE FROM memory_grants WHERE scope_id=${input.scopeId}`;
              yield* sql`DELETE FROM memory_entries WHERE scope_id=${input.scopeId}`;
              yield* sql`DELETE FROM memory_scopes WHERE id=${input.scopeId}`;
              yield* sql`DELETE FROM memory_suggestions WHERE scope_id=${input.scopeId}`;
            }),
          )
          .pipe(Effect.mapError(storage));
        return;
      case "write":
        yield* write(input.entry, { kind: "user" });
        return;
      case "delete":
        yield* forget(input, { kind: "user" });
        return;
      case "connect": {
        if (!(yield* applicability.validate(input.binding)))
          return yield* new SharedMemoryError({ reason: "invalid" });
        const previous = yield* binding(input.binding.scopeId);
        if (previous && previous.ownerEnvironmentId !== input.binding.ownerEnvironmentId)
          return yield* new SharedMemoryError({ reason: "conflict" });
        if (
          input.binding.ownerEnvironmentId === environmentId ||
          (yield* sql`SELECT id FROM memory_scopes WHERE id=${input.binding.scopeId}`.pipe(
            Effect.mapError(storage),
          )).length
        )
          return yield* new SharedMemoryError({ reason: "conflict" });
        yield* request(
          input.binding,
          {
            operation: "query",
            input: { scopeId: input.binding.scopeId, query: "", tokenBudget: 128 },
            author: authorFor({ kind: "user" }),
          },
          input.token,
        );
        yield* secrets
          .set(tokenName(input.binding.scopeId), new TextEncoder().encode(input.token))
          .pipe(Effect.mapError(storage));
        const payload = yield* encode({
          ...input.binding,
          ...(input.binding.rules ? { rules: yield* normalizeRules(input.binding.rules) } : {}),
        }).pipe(Effect.mapError(storage));
        yield* sql`INSERT INTO memory_bindings(scope_id,payload) VALUES (${input.binding.scopeId},${payload}) ON CONFLICT(scope_id) DO UPDATE SET payload=excluded.payload`.pipe(
          Effect.mapError(storage),
        );
        return;
      }
      case "disconnect":
        yield* sql`DELETE FROM memory_bindings WHERE scope_id=${input.scopeId}`.pipe(
          Effect.mapError(storage),
        );
        yield* secrets.remove(tokenName(input.scopeId)).pipe(Effect.mapError(storage));
        return;
    }
  }, Effect.mapError(storage));
  const capture = Effect.fn("SharedMemory.capture")(function* (input: {
    readonly id: string;
    readonly context: MemoryTurnContext;
    readonly text: string;
  }) {
    const settings = yield* readSettings;
    const policy = yield* readThreadPolicy(input.context.threadId);
    if (
      settings.learningMode === "manual" ||
      !policy.learn ||
      input.context.readOnly ||
      !input.text.trim() ||
      sensitiveMemoryText.test(input.text) ||
      !settings.extractorModel.trim() ||
      settings.maxDailyTokens < 8704
    )
      return;
    const actor = { kind: "agent" as const, ...input.context };
    const categories = yield* available(actor);
    if (
      !(yield* targets).some(
        (value) =>
          categories.some((category) => category.id === value.scopeId) &&
          ("writableProviderInstanceIds" in value
            ? value.writableProviderInstanceIds.includes(actor.providerInstanceId)
            : value.access === "write"),
      )
    )
      return;
    const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    const payload = yield* encode({ ...input, text: input.text.slice(0, 12000) });
    yield* sql`INSERT INTO memory_capture_jobs(id,payload,status,day,reserved_tokens) SELECT ${input.id},${payload},'pending',${day},0 WHERE (SELECT COUNT(*) FROM memory_capture_jobs WHERE status='pending') < 200 ON CONFLICT DO NOTHING`;
  }, Effect.mapError(storage));
  const processCaptureJobs = Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      payload: string;
    }>`SELECT id,payload FROM memory_capture_jobs WHERE status='pending' ORDER BY rowid LIMIT 4`;
    for (const row of rows) {
      const job = yield* decodeCaptureJob(row.payload);
      const settings = yield* readSettings;
      const policy = yield* readThreadPolicy(job.context.threadId);
      if (!policy.learn || settings.learningMode === "manual" || !settings.extractorModel.trim())
        continue;
      const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
      const claimed =
        yield* sql`UPDATE memory_capture_jobs SET status='running', day=${day}, reserved_tokens=8704 WHERE id=${row.id} AND status='pending' AND (SELECT COALESCE(SUM(reserved_tokens),0) FROM memory_capture_jobs WHERE day=${day}) + 8704 <= ${settings.maxDailyTokens} RETURNING id`;
      if (!claimed.length) continue;
      const actor = { kind: "agent" as const, ...job.context };
      const result = yield* extractor
        .extract({ text: job.text, model: settings.extractorModel, guidance: settings.guidance })
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* sql`UPDATE memory_capture_jobs SET status='failed',payload='{}' WHERE id=${row.id}`;
        continue;
      }
      const currentJob = yield* sql<{
        status: string;
      }>`SELECT status FROM memory_capture_jobs WHERE id=${row.id}`;
      if (currentJob[0]?.status !== "running") continue;
      const latestSettings = yield* readSettings;
      const latestPolicy = yield* readThreadPolicy(job.context.threadId);
      if (latestSettings.learningMode === "manual" || !latestPolicy.learn) {
        yield* sql`UPDATE memory_capture_jobs SET status='cancelled',payload='{}' WHERE id=${row.id}`;
        continue;
      }
      const categories = yield* available(actor);
      const writable = (yield* targets).filter(
        (value) =>
          categories.some((category) => category.id === value.scopeId) &&
          ("writableProviderInstanceIds" in value
            ? value.writableProviderInstanceIds.includes(actor.providerInstanceId)
            : value.access === "write"),
      );
      const target = selectWriteTarget(writable);
      if (target)
        for (const candidate of result.success.memories) {
          if (
            !candidate.quote.trim() ||
            !job.text.includes(candidate.quote) ||
            !candidate.title.trim() ||
            !candidate.content.trim()
          )
            continue;
          if (sensitiveMemoryText.test(candidate.content + candidate.quote)) continue;
          const id = `learned:${yield* hash(`${target.scopeId}:${candidate.content.trim().toLowerCase()}`)}`;
          const previous =
            yield* sql`SELECT id FROM memory_entries WHERE id=${id} UNION SELECT id FROM memory_suggestions WHERE id=${id}`;
          if (previous.length) continue;
          const entry: typeof MemoryWrite.Type = {
            id,
            scopeId: target.scopeId,
            kind: candidate.kind,
            title: candidate.title,
            content: candidate.content,
            source: {
              reference: `thread:${job.context.threadId}/run:${job.id}; quote: ${candidate.quote.slice(0, 500)}`,
              threadId: job.context.threadId,
            },
          };
          const matches = yield* query(
            { scopeId: target.scopeId, query: candidate.title, tokenBudget: 8192 },
            { kind: "user" },
          );
          const conflict = matches.entries.find(
            (value) => value.title.trim().toLowerCase() === candidate.title.trim().toLowerCase(),
          );
          const proposal = conflict ? { ...entry, supersedes: conflict.id } : entry;
          const suggestion: MemorySuggestion = {
            id,
            entry: proposal,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          };
          if (
            latestSettings.learningMode === "automatic" &&
            candidate.kind === "preference" &&
            !conflict
          )
            yield* write(entry, actor);
          else
            yield* sql`INSERT INTO memory_suggestions(id,scope_id,payload,status) VALUES (${id},${target.scopeId},${yield* encode(suggestion)},'pending') ON CONFLICT DO NOTHING`;
        }
      yield* sql`UPDATE memory_capture_jobs SET status='completed',payload='{}' WHERE id=${row.id}`;
    }
  }).pipe(Effect.mapError(storage));
  return SharedMemory.of({
    available,
    recall,
    capture,
    processCaptureJobs,
    forget,
    acknowledgeRecall: Effect.fn("SharedMemory.acknowledgeRecall")(function* (id) {
      const rows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_receipts WHERE id=${id}`;
      if (!rows[0]) return;
      const receipt = yield* decodeReceipt(rows[0].payload);
      if (!receipt.contextKey || receipt.status === "disabled") return;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM memory_context_entries WHERE thread_id=${receipt.threadId} AND context_key<>${receipt.contextKey!}`;
          for (const entry of receipt.entries.filter((entry) =>
            receipt.sentEntryIds?.includes(entry.id),
          ))
            yield* sql`INSERT INTO memory_context_entries(thread_id,context_key,entry_id,version) VALUES (${receipt.threadId},${receipt.contextKey!},${entry.id},${entry.version}) ON CONFLICT(thread_id,context_key,entry_id) DO UPDATE SET version=excluded.version`;
        }),
      );
    }, Effect.mapError(storage)),
    recoverCaptureJobs:
      sql`UPDATE memory_capture_jobs SET status='interrupted',payload='{}' WHERE status='running'`.pipe(
        Effect.asVoid,
        Effect.mapError(storage),
      ),
    status: Effect.fn("SharedMemory.status")(function* (threadId) {
      const rows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_receipts WHERE thread_id=${threadId} ORDER BY rowid DESC LIMIT 1`;
      return {
        receipt: rows[0] ? yield* decodeReceipt(rows[0].payload) : null,
        policy: yield* readThreadPolicy(threadId),
      };
    }, Effect.mapError(storage)),
    state: Effect.gen(function* () {
      const scopes = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_scopes ORDER BY id`.pipe(Effect.mapError(storage));
      const bindings = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_bindings ORDER BY scope_id`.pipe(Effect.mapError(storage));
      const applied = yield* appliedProfile.pipe(Effect.mapError(storage));
      const receiptRows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_receipts ORDER BY rowid DESC LIMIT 30`.pipe(
        Effect.mapError(storage),
      );
      const suggestionRows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_suggestions WHERE status='pending' ORDER BY rowid DESC LIMIT 100`.pipe(
        Effect.mapError(storage),
      );
      const policyRows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_thread_policies`.pipe(Effect.mapError(storage));
      const jobs = yield* sql<{
        status: string;
        count: number;
      }>`SELECT status,COUNT(*) AS count FROM memory_capture_jobs GROUP BY status`.pipe(
        Effect.mapError(storage),
      );
      const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
      const usage = yield* sql<{
        reservedTokens: number;
      }>`SELECT COALESCE(SUM(reserved_tokens),0) AS reservedTokens FROM memory_capture_jobs WHERE day=${day}`.pipe(
        Effect.mapError(storage),
      );
      return {
        captureUsage: { reservedTokens: usage[0]?.reservedTokens ?? 0, jobs },
        settings: yield* readSettings,
        receipts: yield* Effect.forEach(receiptRows, (row) =>
          decodeReceipt(row.payload).pipe(Effect.mapError(storage)),
        ),
        suggestions: yield* Effect.forEach(suggestionRows, (row) =>
          decodeSuggestion(row.payload).pipe(Effect.mapError(storage)),
        ),
        threadPolicies: yield* Effect.forEach(policyRows, (row) =>
          decodeThreadPolicy(row.payload).pipe(Effect.mapError(storage)),
        ),
        grants:
          yield* sql`SELECT scope_id AS scopeId, destination_id AS destinationEnvironmentId, access FROM memory_grants`.pipe(
            Effect.flatMap(decodeGrants),
            Effect.mapError(storage),
          ),
        profileScopes: applied?.profile.memoryScopes ?? [],
        scopes: yield* Effect.forEach(scopes, (r) =>
          decodeScope(r.payload).pipe(Effect.mapError(storage)),
        ),
        bindings: yield* Effect.forEach(bindings, (r) =>
          decodeBinding(r.payload).pipe(Effect.mapError(storage)),
        ),
      };
    }),
    command,
    query,
    write,
    exportScope: Effect.fn("SharedMemory.export")(function* (id) {
      const target = yield* scope(id);
      const rows = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_entries WHERE scope_id=${id} ORDER BY rowid LIMIT 10001`.pipe(
        Effect.mapError(storage),
      );
      if (rows.length > 10000) return yield* new SharedMemoryError({ reason: "invalid" });
      return {
        scope: target,
        entries: yield* Effect.forEach(rows, (r) =>
          decodeEntry(r.payload).pipe(Effect.mapError(storage)),
        ),
      };
    }),
    grant: Effect.fn("SharedMemory.grant")(function* (input) {
      yield* scope(input.scopeId);
      const token = input.revoke
        ? null
        : yield* crypto.randomBytes(32).pipe(Effect.map(Hex.encode), Effect.orDie);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM memory_grants WHERE scope_id=${input.scopeId} AND destination_id=${input.destinationEnvironmentId}`;
            if (token)
              yield* sql`INSERT INTO memory_grants(token_hash,scope_id,destination_id,access) VALUES (${yield* hash(token)},${input.scopeId},${input.destinationEnvironmentId},${input.access})`;
          }),
        )
        .pipe(Effect.mapError(storage));
      return { token };
    }),
    serve: Effect.fn("SharedMemory.serve")(function* (token, payload) {
      const grants = yield* sql<{
        access: string;
      }>`SELECT access FROM memory_grants WHERE token_hash=${yield* hash(token)} AND scope_id=${payload.input.scopeId} AND destination_id=${payload.author.environmentId}`.pipe(
        Effect.mapError(storage),
      );
      if (!token || !grants[0] || (payload.operation !== "query" && grants[0].access !== "write"))
        return yield* denied();
      yield* scope(payload.input.scopeId);
      if (payload.operation === "query") return yield* queryLocal(payload.input);
      if (payload.operation === "write") return yield* writeLocal(payload.input, payload.author);
      yield* forgetLocal(payload.input);
      return { forgotten: true };
    }),
  });
});
export const layer = Layer.effect(SharedMemory, make).pipe(
  Layer.provide(MemoryApplicability.layer),
  Layer.provide(MemoryExtractor.layer),
);
