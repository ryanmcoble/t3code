import * as SetupProfileStore from "../setupProfiles/SetupProfileStore.ts";
import { readAppliedProfile } from "../setupProfiles/appliedProfile.ts";
import {
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
    };
export const MemoryWireRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("query"), input: MemoryQuery, author: MemoryAuthor }),
  Schema.Struct({ operation: Schema.Literal("write"), input: MemoryWrite, author: MemoryAuthor }),
]);

export class SharedMemory extends Context.Service<
  SharedMemory,
  {
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
    ) => Effect.Effect<typeof MemoryQueryResult.Type | MemoryEntry, SharedMemoryError>;
  }
>()("t3/memory/SharedMemory") {}

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeScope = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryScope));
const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryEntry));
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryRemoteBinding));
const decodeDescriptor = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentId }),
);
const decodeQueryResult = Schema.decodeUnknownEffect(MemoryQueryResult);
const decodeMemoryEntry = Schema.decodeUnknownEffect(MemoryEntry);
const decodeRemoteResult = Schema.decodeUnknownEffect(
  Schema.Union([MemoryQueryResult, MemoryEntry]),
);
const decodeGrants = Schema.decodeUnknownEffect(Schema.Array(MemoryGrantSummary));
const isMemoryError = Schema.is(SharedMemoryError);
const storage = (cause: unknown) =>
  isMemoryError(cause) ? cause : new SharedMemoryError({ reason: "storage", cause });
const denied = () => new SharedMemoryError({ reason: "denied" });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  const allow = (
    target: Pick<MemoryScope, "projectIds" | "providerInstanceIds">,
    actor: MemoryActor,
  ) =>
    actor.kind === "user" ||
    (target.projectIds.includes(actor.projectId as (typeof target.projectIds)[number]) &&
      target.providerInstanceIds.includes(actor.providerInstanceId))
      ? Effect.void
      : Effect.fail(denied());
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
    const search = terms.map((term) => `"${term}"*`).join(" AND ");
    const rows = yield* search
      ? sql<{
          payload: string;
        }>`SELECT e.payload FROM memory_search s JOIN memory_entries e ON e.id=s.id
          WHERE memory_search MATCH ${search} AND e.scope_id=${input.scopeId} AND e.active=1 ORDER BY rank LIMIT 101`
      : sql<{
          payload: string;
        }>`SELECT payload FROM memory_entries WHERE scope_id=${input.scopeId} AND active=1 ORDER BY rowid DESC LIMIT 101`;
    const entries: MemoryEntry[] = [];
    let estimatedTokens = 0;
    let truncated = rows.length > 100;
    for (const row of rows.slice(0, 100)) {
      const entry = yield* decodeEntry(row.payload);
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
              entry.supersedes === (input.supersedes ?? null)
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
  const command = Effect.fn("SharedMemory.command")(function* (input: typeof MemoryCommand.Type) {
    switch (input.operation) {
      case "scope-save": {
        if (input.scope.revision !== input.expectedRevision + 1 || (yield* binding(input.scope.id)))
          return yield* new SharedMemoryError({ reason: "invalid" });
        const payload = yield* encode(input.scope).pipe(Effect.mapError(storage));
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
            }),
          )
          .pipe(Effect.mapError(storage));
        return;
      case "write":
        yield* write(input.entry, { kind: "user" });
        return;
      case "delete": {
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
      }
      case "connect": {
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
        const payload = yield* encode(input.binding).pipe(Effect.mapError(storage));
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
  });
  return SharedMemory.of({
    state: Effect.gen(function* () {
      const scopes = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_scopes ORDER BY id`.pipe(Effect.mapError(storage));
      const bindings = yield* sql<{
        payload: string;
      }>`SELECT payload FROM memory_bindings ORDER BY scope_id`.pipe(Effect.mapError(storage));
      const applied = yield* appliedProfile.pipe(Effect.mapError(storage));
      return {
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
      if (!token || !grants[0] || (payload.operation === "write" && grants[0].access !== "write"))
        return yield* denied();
      yield* scope(payload.input.scopeId);
      return payload.operation === "query"
        ? yield* queryLocal(payload.input)
        : yield* writeLocal(payload.input, payload.author);
    }),
  });
});
export const layer = Layer.effect(SharedMemory, make);
