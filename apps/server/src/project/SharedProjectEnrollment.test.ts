import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  SharedProjectError,
  type ExecutionEnvironmentDescriptor,
  type SharedProjectManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SharedProjects from "./SharedProjects.ts";
import * as Enrollment from "./SharedProjectEnrollment.ts";

const owner = EnvironmentId.make("owner");
const member = EnvironmentId.make("member");
const third = EnvironmentId.make("third");
const manifest: SharedProjectManifest = {
  id: "sample",
  ownerEnvironmentId: owner,
  revision: 1,
  name: "Shared sample",
  members: [owner, member, third],
  setupProfileId: null,
  archived: false,
  roots: [
    {
      id: "docs",
      name: "Documents",
      kind: "files",
      contentPolicy: { mode: "project-content", excludePaths: [] },
    },
  ],
};
const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId: owner,
  label: "Owner",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: false, sharedProjectEnrollment: 1 },
};
const connect = {
  operation: "connect",
  sharedProjectId: manifest.id,
  ownerEnvironmentId: owner,
  sourceUrl: "https://owner.test",
  token: "test-only-credential",
} as const;

it.effect(
  "keeps default grants metadata-only and requires separate repository-history access",
  () => {
    const test = fixture(owner);
    return Effect.gen(function* () {
      const service = yield* Enrollment.SharedProjectEnrollment;
      const metadata = yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: member,
        revoke: false,
      });
      const request = {
        projectId: manifest.id,
        destinationId: member,
        token: metadata.token!,
        history: false,
      };
      assert.equal((yield* service.authorizeContent(request).pipe(Effect.result))._tag, "Failure");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        access: string;
      }>`SELECT access FROM shared_project_grants WHERE destination_id=${member}`;
      assert.equal(rows[0]?.access, "metadata");
      const files = yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: member,
        revoke: false,
        access: "files",
      });
      assert.equal(
        (yield* service.authorizeContent({ ...request, token: files.token! })).id,
        manifest.id,
      );
      assert.equal(
        (yield* service
          .authorizeContent({ ...request, token: files.token!, history: true })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const history = yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: member,
        revoke: false,
        access: "repository-history",
      });
      assert.equal(
        (yield* service.authorizeContent({ ...request, token: history.token!, history: true })).id,
        manifest.id,
      );
      yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: member,
        revoke: true,
      });
      assert.equal(
        (yield* service.authorizeContent({ ...request, token: history.token! }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
    }).pipe(
      Effect.provide(
        test.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      ),
      Effect.scoped,
    );
  },
);

const fixture = (environmentId: EnvironmentId) => {
  let current = manifest;
  let advertised = descriptor;
  let status = 200;
  let reads = 0;
  const cached: SharedProjectManifest[] = [];
  const secretValues = new Map<string, Uint8Array>();
  const projects = Layer.mock(SharedProjects.SharedProjects)({
    get: () => Effect.succeed(current),
    state: Effect.sync(() => ({ projects: cached, bindings: [], complete: true })),
    receive: (value, expectedOwner) =>
      Effect.gen(function* () {
        if (value.ownerEnvironmentId !== expectedOwner || !value.members.includes(environmentId))
          return yield* new SharedProjectError({ reason: "denied" });
        cached.push(value);
      }),
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      reads += 1;
      return HttpClientResponse.fromWeb(
        request,
        request.url.includes(".well-known")
          ? Response.json(advertised)
          : status === 200
            ? Response.json(current)
            : new Response(null, { status, headers: { location: "https://wrong.test" } }),
      );
    }),
  );
  const layer = Enrollment.layer.pipe(
    Layer.provide(projects),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.sync(() => Option.fromNullishOr(secretValues.get(name))),
        set: (name, bytes) =>
          Effect.sync(() => {
            secretValues.set(name, bytes);
          }),
        remove: (name) =>
          Effect.sync(() => {
            secretValues.delete(name);
          }),
      }),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return {
    layer,
    secretValues,
    cached,
    setManifest: (value: SharedProjectManifest) => {
      current = value;
    },
    setDescriptor: (value: ExecutionEnvironmentDescriptor) => {
      advertised = value;
    },
    setStatus: (value: number) => {
      status = value;
    },
    reads: () => reads,
  };
};

it.effect(
  "restricts grants to selected members, rotates one member without affecting another and revokes immediately",
  () => {
    const test = fixture(owner);
    return Effect.gen(function* () {
      const service = yield* Enrollment.SharedProjectEnrollment;
      const first = yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: member,
        revoke: false,
      });
      const other = yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: third,
        revoke: false,
      });
      assert.equal((yield* service.serve(manifest.id, member, first.token!)).revision, 1);
      const sql = yield* SqlClient.SqlClient;
      const stored = yield* sql<{
        token_hash: string;
      }>`SELECT token_hash FROM shared_project_grants`;
      assert.isTrue(
        stored.every((row) => row.token_hash.length === 64 && row.token_hash !== first.token),
      );
      assert.equal(
        (yield* service.serve(manifest.id, third, first.token!).pipe(Effect.result))._tag,
        "Failure",
      );
      const renewed = yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: member,
        revoke: false,
      });
      assert.notEqual(first.token, renewed.token);
      assert.equal(
        (yield* service.serve(manifest.id, member, first.token!).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* service.serve(manifest.id, third, other.token!)).revision, 1);
      yield* service.grant({
        sharedProjectId: manifest.id,
        destinationEnvironmentId: member,
        revoke: true,
      });
      assert.equal(
        (yield* service.serve(manifest.id, member, renewed.token!).pipe(Effect.result))._tag,
        "Failure",
      );
      const missing = yield* service
        .grant({
          sharedProjectId: manifest.id,
          destinationEnvironmentId: EnvironmentId.make("outsider"),
          revoke: false,
        })
        .pipe(Effect.result);
      assert.equal(missing._tag, "Failure");
      test.setManifest({ ...manifest, members: [owner] });
      assert.equal(
        (yield* service.serve(manifest.id, third, other.token!).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.provide(
        test.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      ),
      Effect.scoped,
    );
  },
);

it.effect(
  "persists a member subscription, catches up without a desktop, pauses, recovers offline and disconnects without deleting cached content",
  () => {
    const test = fixture(member);
    return Effect.gen(function* () {
      const service = yield* Enrollment.SharedProjectEnrollment;
      yield* service.command(connect);
      assert.equal(test.secretValues.size, 1);
      assert.equal((yield* service.state).subscriptions[0]?.observedRevision, 1);
      test.setManifest({ ...manifest, revision: 2 });
      yield* service.reconcile;
      assert.equal((yield* service.state).subscriptions[0]?.observedRevision, 2);
      yield* service.command({ operation: "pause", sharedProjectId: manifest.id, paused: true });
      const reads = test.reads();
      yield* service.reconcile;
      assert.equal(test.reads(), reads);
      yield* service.command({ operation: "pause", sharedProjectId: manifest.id, paused: false });
      test.setStatus(503);
      yield* service.reconcile;
      assert.isNotNull((yield* service.state).subscriptions[0]?.error);
      assert.equal((yield* service.state).subscriptions[0]?.observedRevision, 2);
      test.setStatus(200);
      yield* service.reconcile;
      assert.isNull((yield* service.state).subscriptions[0]?.error);
      yield* service.command({ operation: "disconnect", sharedProjectId: manifest.id });
      assert.equal(test.secretValues.size, 0);
      assert.equal((yield* service.state).subscriptions.length, 0);
      assert.isTrue(test.cached.length > 0);
    }).pipe(
      Effect.provide(
        test.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      ),
      Effect.scoped,
    );
  },
);

it.effect(
  "rejects another machine, redirects, insecure origins and unsupported owners before saving credentials",
  () => {
    const test = fixture(member);
    return Effect.gen(function* () {
      const service = yield* Enrollment.SharedProjectEnrollment;
      test.setDescriptor({ ...descriptor, environmentId: third });
      assert.equal((yield* service.command(connect).pipe(Effect.result))._tag, "Failure");
      assert.equal(test.reads(), 1);
      test.setDescriptor({ ...descriptor, capabilities: { repositoryIdentity: false } });
      assert.equal((yield* service.command(connect).pipe(Effect.result))._tag, "Failure");
      test.setDescriptor(descriptor);
      test.setStatus(302);
      assert.equal((yield* service.command(connect).pipe(Effect.result))._tag, "Failure");
      for (const sourceUrl of [
        "http://owner.test",
        "https://owner.test/path",
        "https://user:pass@owner.test",
        "https://owner.test?token=secret",
      ]) {
        assert.equal(
          (yield* service.command({ ...connect, sourceUrl }).pipe(Effect.result))._tag,
          "Failure",
        );
      }
      assert.equal(test.secretValues.size, 0);
      assert.equal((yield* service.state).subscriptions.length, 0);
    }).pipe(
      Effect.provide(
        test.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      ),
      Effect.scoped,
    );
  },
);
