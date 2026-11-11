import {
  ExecutionEnvironmentDescriptor,
  SharedProjectError,
  SharedProjectManifest,
  SharedProjectSubscription,
  SharedProjectContentError,
  SharedProjectContentResponse,
  type SharedProjectContentRequest,
  type SharedProjectGrantInput,
  type SharedProjectGrantResult,
  type SharedProjectEnrollmentCommand,
  type SharedProjectEnrollmentState,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SharedProjects from "./SharedProjects.ts";

export class SharedProjectEnrollment extends Context.Service<
  SharedProjectEnrollment,
  {
    readonly state: Effect.Effect<typeof SharedProjectEnrollmentState.Type, SharedProjectError>;
    readonly grant: (
      input: typeof SharedProjectGrantInput.Type,
    ) => Effect.Effect<typeof SharedProjectGrantResult.Type, SharedProjectError>;
    readonly serve: (
      projectId: string,
      destinationId: string,
      token: string,
    ) => Effect.Effect<SharedProjectManifest, SharedProjectError>;
    readonly authorizeContent: (input: {
      readonly projectId: string;
      readonly destinationId: string;
      readonly token: string;
      readonly history: boolean;
    }) => Effect.Effect<SharedProjectManifest, SharedProjectError>;
    readonly command: (
      input: typeof SharedProjectEnrollmentCommand.Type,
    ) => Effect.Effect<void, SharedProjectError>;
    readonly reconcile: Effect.Effect<void, SharedProjectError>;
    readonly contentRequest: (
      projectId: string,
      request: typeof SharedProjectContentRequest.Type,
    ) => Effect.Effect<
      typeof SharedProjectContentResponse.Type,
      SharedProjectError | SharedProjectContentError
    >;
  }
>()("t3/project/SharedProjectEnrollment") {}

const codec = Schema.fromJsonString(SharedProjectSubscription);
const decodeContentResponse = Schema.decodeUnknownEffect(SharedProjectContentResponse);
const decodeContentFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ reason: SharedProjectContentError.fields.reason }),
);
const storage = () => new SharedProjectError({ reason: "storage" });
const denied = () => new SharedProjectError({ reason: "denied" });
const unreachable = () => new SharedProjectError({ reason: "unreachable" });
const tokenName = (id: string) => `shared-project-${id}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* SharedProjects.SharedProjects;
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.withScope,
    HttpClient.transform((effect) =>
      effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })),
    ),
  );
  const gate = yield* Semaphore.make(1);
  const digest = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(Hex.encode), Effect.mapError(storage));
  const read = Effect.fn("SharedProjectEnrollment.read")(function* (id?: string) {
    const rows = yield* sql<{
      readonly payload: string;
    }>`SELECT payload FROM shared_project_subscriptions WHERE (${id ?? null} IS NULL OR project_id=${id ?? null}) ORDER BY project_id LIMIT 201`.pipe(
      Effect.mapError(storage),
    );
    return yield* Effect.forEach(rows, (row) =>
      Schema.decodeEffect(codec)(row.payload).pipe(Effect.mapError(storage)),
    );
  });
  const save = Effect.fn("SharedProjectEnrollment.save")(function* (
    value: SharedProjectSubscription,
  ) {
    const payload = yield* Schema.encodeEffect(codec)(value);
    yield* sql`INSERT INTO shared_project_subscriptions(project_id,payload) VALUES(${value.sharedProjectId},${payload}) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload`;
  }, Effect.mapError(storage));
  const owned = Effect.fn("SharedProjectEnrollment.owned")(function* (id: string) {
    const project = yield* projects.get(id);
    if (project.ownerEnvironmentId !== environmentId)
      return yield* new SharedProjectError({ reason: "owner" });
    return project;
  });
  const authorize = Effect.fn("SharedProjectEnrollment.authorize")(function* (
    id: string,
    destinationId: string,
    token: string,
    required: "metadata" | "files" | "repository-history",
  ) {
    if (!token || token.length > 256) return yield* denied();
    const hash = yield* digest(token);
    const rows = yield* sql<{
      readonly access: string;
    }>`SELECT access FROM shared_project_grants WHERE project_id=${id} AND destination_id=${destinationId} AND token_hash=${hash}`.pipe(
      Effect.mapError(storage),
    );
    const access = rows[0]?.access;
    if (
      !access ||
      (required === "files" && access === "metadata") ||
      (required === "repository-history" && access !== "repository-history")
    )
      return yield* denied();
    const project = yield* owned(id);
    if (!project.members.some((id) => id === destinationId)) return yield* denied();
    return project;
  });
  const origin = (sourceUrl: string) =>
    Effect.try({
      try: () => {
        const url = new URL(sourceUrl);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.pathname !== "/" && url.pathname !== "") ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            ))
        )
          throw new Error("Invalid owner origin");
        return url.origin;
      },
      catch: () => new SharedProjectError({ reason: "invalid-manifest" }),
    });
  const fetchManifest = Effect.fn("SharedProjectEnrollment.fetchManifest")(function* (
    binding: SharedProjectSubscription,
    token: string,
    requireContent = false,
  ) {
    const url = yield* origin(binding.sourceUrl);
    const descriptor = yield* http.get(`${url}/.well-known/t3/environment`).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status !== 200) return yield* unreachable();
          return yield* response.json;
        }),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)),
      Effect.scoped,
      Effect.timeout("10 seconds"),
      Effect.mapError(unreachable),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1)),
    );
    if (descriptor.environmentId !== binding.ownerEnvironmentId) return yield* denied();
    if (descriptor.capabilities.sharedProjectEnrollment !== 1)
      return yield* new SharedProjectError({ reason: "unsupported" });
    if (requireContent && descriptor.capabilities.sharedProjectFileContent !== 1)
      return yield* new SharedProjectError({ reason: "unsupported-content" });
    const manifest = yield* http
      .execute(
        HttpClientRequest.get(
          `${url}/api/shared-projects/${encodeURIComponent(binding.sharedProjectId)}`,
        ).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${token}`,
            "t3-project-destination": environmentId,
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200)
              return yield* response.status === 403 ? denied() : unreachable();
            return yield* response.json;
          }),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(SharedProjectManifest)),
        Effect.scoped,
        Effect.timeout("20 seconds"),
        Effect.mapError((error) => (error._tag === "SharedProjectError" ? error : unreachable())),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1)),
      );
    if (
      manifest.id !== binding.sharedProjectId ||
      manifest.ownerEnvironmentId !== binding.ownerEnvironmentId
    )
      return yield* denied();
    yield* projects.receive(manifest, binding.ownerEnvironmentId);
    return manifest.revision;
  });
  const refresh = Effect.fn("SharedProjectEnrollment.refresh")(function* (
    binding: SharedProjectSubscription,
    token?: string,
  ) {
    const checkedAt = yield* Clock.currentTimeMillis;
    const result = yield* Effect.gen(function* () {
      const saved =
        token === undefined
          ? yield* secrets.get(tokenName(binding.sharedProjectId)).pipe(Effect.mapError(storage))
          : Option.some(new TextEncoder().encode(token));
      if (Option.isNone(saved)) return yield* denied();
      return yield* fetchManifest(binding, new TextDecoder().decode(saved.value));
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* save({ ...binding, lastCheckedAt: checkedAt, error: result.failure.message });
      return yield* result.failure;
    }
    yield* save({
      ...binding,
      observedRevision: result.success,
      lastCheckedAt: checkedAt,
      error: null,
    });
  });
  return SharedProjectEnrollment.of({
    contentRequest: Effect.fn("SharedProjectEnrollment.contentRequest")((projectId, request) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const binding = (yield* read(projectId))[0];
          if (!binding || binding.paused)
            return yield* new SharedProjectContentError({ reason: "unmapped" });
          const saved = yield* secrets.get(tokenName(projectId)).pipe(Effect.mapError(storage));
          if (Option.isNone(saved)) return yield* denied();
          const token = new TextDecoder().decode(saved.value);
          if (request.operation === "observe" || request.operation === "start")
            yield* fetchManifest(binding, token, true);
          const url = yield* origin(binding.sourceUrl);
          const body = yield* HttpClientRequest.post(
            `${url}/api/shared-projects/${encodeURIComponent(projectId)}/content`,
          ).pipe(HttpClientRequest.bodyJson(request), Effect.mapError(unreachable));
          return yield* http
            .execute(
              body.pipe(
                HttpClientRequest.setHeaders({
                  authorization: `Bearer ${token}`,
                  "t3-project-destination": environmentId,
                }),
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                Effect.gen(function* () {
                  if (response.status === 403) return yield* denied();
                  if (response.status === 409) {
                    const failure = yield* response.json.pipe(Effect.flatMap(decodeContentFailure));
                    return yield* new SharedProjectContentError({ ...failure, origin: "owner" });
                  }
                  if (response.status !== 200) return yield* unreachable();
                  return yield* response.json.pipe(Effect.flatMap(decodeContentResponse));
                }),
              ),
              Effect.scoped,
              Effect.timeout("30 seconds"),
              Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(2)),
              Effect.mapError((error) =>
                error._tag === "SharedProjectError" || error._tag === "SharedProjectContentError"
                  ? error
                  : unreachable(),
              ),
            );
        }),
      ),
    ),
    state: read().pipe(
      Effect.map((subscriptions) => ({
        subscriptions: subscriptions.slice(0, 200),
        complete: subscriptions.length <= 200,
      })),
    ),
    grant: Effect.fn("SharedProjectEnrollment.grant")((input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const project = yield* owned(input.sharedProjectId);
          if (
            !input.revoke &&
            (!project.members.includes(input.destinationEnvironmentId) ||
              input.destinationEnvironmentId === environmentId ||
              project.archived)
          )
            return yield* denied();
          if (input.revoke) {
            yield* sql`DELETE FROM shared_project_grants WHERE project_id=${project.id} AND destination_id=${input.destinationEnvironmentId} AND (${input.access ?? null} IS NULL OR access=${input.access ?? null})`.pipe(
              Effect.mapError(storage),
            );
            return { token: null };
          }
          const token = yield* crypto.randomBytes(32).pipe(
            Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
            Effect.mapError(storage),
          );
          const hash = yield* digest(token);
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                // Legacy replacement still revokes all scopes; explicit scopes rotate independently.
                if (input.access === undefined)
                  yield* sql`DELETE FROM shared_project_grants WHERE project_id=${project.id} AND destination_id=${input.destinationEnvironmentId}`;
                yield* sql`INSERT INTO shared_project_grants(project_id,destination_id,token_hash,access) VALUES(${project.id},${input.destinationEnvironmentId},${hash},${input.access ?? "metadata"}) ON CONFLICT(project_id,destination_id,access) DO UPDATE SET token_hash=excluded.token_hash`;
              }),
            )
            .pipe(Effect.mapError(storage));
          return { token };
        }),
      ),
    ),
    serve: Effect.fn("SharedProjectEnrollment.serve")((id, destinationId, token) =>
      authorize(id, destinationId, token, "metadata"),
    ),
    authorizeContent: Effect.fn("SharedProjectEnrollment.authorizeContent")((input) =>
      authorize(
        input.projectId,
        input.destinationId,
        input.token,
        input.history ? "repository-history" : "files",
      ),
    ),
    command: Effect.fn("SharedProjectEnrollment.command")((input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const previous = (yield* read(input.sharedProjectId))[0];
          if (input.operation === "connect") {
            if (
              input.ownerEnvironmentId === environmentId ||
              (previous && previous.ownerEnvironmentId !== input.ownerEnvironmentId)
            )
              return yield* denied();
            if (!previous && (yield* read()).length >= 200)
              return yield* new SharedProjectError({ reason: "invalid-manifest" });
            const sourceUrl = yield* origin(input.sourceUrl);
            const binding: SharedProjectSubscription = {
              sharedProjectId: input.sharedProjectId,
              ownerEnvironmentId: input.ownerEnvironmentId,
              sourceUrl,
              paused: false,
              observedRevision: previous?.observedRevision ?? 0,
              lastCheckedAt: null,
              error: null,
              receiveFiles: input.receiveFiles ?? false,
            };
            // Validate the owner and grant before replacing the stored credential.
            const revision = yield* fetchManifest(binding, input.token);
            yield* secrets
              .set(tokenName(input.sharedProjectId), new TextEncoder().encode(input.token))
              .pipe(Effect.mapError(storage));
            yield* save({
              ...binding,
              observedRevision: revision,
              lastCheckedAt: yield* Clock.currentTimeMillis,
            });
          } else {
            if (!previous) return yield* new SharedProjectError({ reason: "not-found" });
            if (input.operation === "disconnect") {
              yield* secrets
                .remove(tokenName(input.sharedProjectId))
                .pipe(Effect.mapError(storage));
              yield* sql`DELETE FROM shared_project_subscriptions WHERE project_id=${input.sharedProjectId}`.pipe(
                Effect.mapError(storage),
              );
              const binding = (yield* projects.state).bindings.find(
                (binding) => binding.sharedProjectId === input.sharedProjectId,
              );
              if (binding && !binding.detached)
                yield* projects.unbind(input.sharedProjectId, binding.revision);
            } else if (input.operation === "receive-files")
              yield* save({ ...previous, receiveFiles: input.enabled });
            else if (input.operation === "pause")
              yield* save({ ...previous, paused: input.paused });
            else yield* refresh(previous);
          }
        }),
      ),
    ),
    reconcile: gate.withPermits(1)(
      Effect.gen(function* () {
        for (const subscription of yield* read()) {
          if (!subscription.paused)
            yield* refresh(subscription).pipe(
              Effect.catch((error) =>
                Effect.logDebug("Shared project owner refresh failed", {
                  projectId: subscription.sharedProjectId,
                  reason: error.reason,
                }),
              ),
            );
        }
      }),
    ),
  });
});

export const layer = Layer.effect(SharedProjectEnrollment, make);
export const start = Effect.gen(function* () {
  const service = yield* SharedProjectEnrollment;
  yield* service.reconcile.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Shared project enrollment reconciliation failed", {
        reason: error.reason,
      }),
    ),
    Effect.repeat(Schedule.spaced("15 seconds")),
    Effect.forkScoped,
  );
});
