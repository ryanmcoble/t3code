import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  type SharedProjectBinding,
  type SharedProjectContentRequest,
  type SharedProjectManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ContentSource from "./SharedProjectContentSource.ts";
import * as Enrollment from "./SharedProjectEnrollment.ts";
import * as ProjectFolderTransfer from "./ProjectFolderTransfer.ts";
import * as SharedProjects from "./SharedProjects.ts";

const owner = EnvironmentId.make("owner");
const member = EnvironmentId.make("member");
const third = EnvironmentId.make("third");
const localProject = ProjectId.make("local");
const base: SharedProjectManifest = {
  id: "sample",
  ownerEnvironmentId: owner,
  revision: 1,
  name: "Sample",
  members: [owner, member, third],
  archived: false,
  setupProfileId: null,
  roots: [
    {
      id: "docs",
      name: "Documents",
      kind: "files",
      contentPolicy: { mode: "project-content", excludePaths: ["private-notes"] },
    },
  ],
};

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-content-test-" });
  const cwd = yield* fs.realPath(temporary);
  yield* fs.writeFileString(`${cwd}/README.md`, "public content");
  yield* fs.writeFileString(`${cwd}/.env`, "local secret");
  yield* fs.makeDirectory(`${cwd}/.git`);
  yield* fs.writeFileString(`${cwd}/.git/config`, "local repository state");
  yield* fs.makeDirectory(`${cwd}/private-notes`);
  yield* fs.writeFileString(`${cwd}/private-notes/draft.md`, "private draft");
  let manifest = base;
  let registeredPath = cwd;
  let binding: SharedProjectBinding = {
    sharedProjectId: base.id,
    environmentId: owner,
    manifestRevision: 1,
    revision: 1,
    detached: false,
    paused: false,
    roots: [{ rootId: "docs", projectId: localProject, path: cwd }],
  };
  const projects = Layer.mock(SharedProjects.SharedProjects)({
    get: () => Effect.sync(() => manifest),
    getBinding: () => Effect.sync(() => binding),
  });
  const enrollment = Enrollment.layer.pipe(
    Layer.provide(projects),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(owner),
      }),
    ),
    Layer.provide(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Source must not make HTTP requests")),
      ),
    ),
  );
  const layer = ContentSource.layer.pipe(
    Layer.provideMerge(enrollment),
    Layer.provide(projects),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: () =>
          Effect.sync(() =>
            Option.some({
              id: localProject,
              title: "Documents",
              workspaceRoot: registeredPath,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-11-11T00:00:00Z",
              updatedAt: "2026-11-11T00:00:00Z",
            }),
          ),
      }),
    ),
    Layer.provide(
      ProjectFolderTransfer.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
        ),
        Layer.provide(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-shared-source-config-",
          }),
        ),
      ),
    ),
  );
  return {
    cwd,
    layer,
    setManifest: (value: SharedProjectManifest) => {
      manifest = value;
    },
    setBinding: (value: Partial<SharedProjectBinding>) => {
      binding = { ...binding, ...value };
    },
    setRegisteredPath: (value: string) => {
      registeredPath = value;
    },
  };
});
const start = { operation: "start", rootId: "docs", expectedManifestRevision: 1 } as const;
const request = (
  token: string,
  body: typeof SharedProjectContentRequest.Type,
  destinationId = member,
) =>
  Effect.flatMap(ContentSource.SharedProjectContentSource, (service) =>
    service.request({ projectId: base.id, destinationId, token, request: body }),
  );
const grant = (access: "metadata" | "files" = "files", destinationEnvironmentId = member) =>
  Effect.flatMap(Enrollment.SharedProjectEnrollment, (service) =>
    service.grant({
      sharedProjectId: base.id,
      destinationEnvironmentId,
      access,
      revoke: false,
    }),
  ).pipe(Effect.map((value) => value.token!));
const testLayer = Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "pages filtered snapshots, validates chunks and rejects a source changed before completion",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      for (let index = 0; index < 300; index++)
        yield* fs.writeFileString(`${test.cwd}/item-${index}`, "item");
      yield* Effect.gen(function* () {
        const metadata = yield* grant("metadata");
        const denied = yield* request(metadata, start).pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        if (denied._tag === "Failure") assert.equal(denied.failure.reason, "denied");
        const token = yield* grant();
        const observed = yield* request(token, { ...start, operation: "observe" });
        assert.equal(observed.kind, "observation");
        const snapshot = yield* request(token, start);
        assert.equal(snapshot.kind, "snapshot");
        if (snapshot.kind !== "snapshot") return;
        assert.equal(snapshot.entryCount, 301);
        assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
        const first = yield* request(token, {
          operation: "entries",
          sessionId: snapshot.sessionId,
          cursor: 0,
        });
        assert.equal(first.kind, "entries");
        if (first.kind !== "entries") return;
        assert.equal(first.entries.length, 256);
        assert.equal(first.nextCursor, 256);
        assert.isFalse(
          first.entries.some(
            (entry) =>
              entry.path.startsWith(".env") ||
              entry.path.startsWith(".git") ||
              entry.path.startsWith("private-notes"),
          ),
        );
        const last = yield* request(token, {
          operation: "entries",
          sessionId: snapshot.sessionId,
          cursor: 256,
        });
        if (last.kind !== "entries") return assert.fail("Expected final entries page");
        assert.equal(last.entries.length, 45);
        assert.isNull(last.nextCursor);
        const chunk = yield* request(token, {
          operation: "read",
          sessionId: snapshot.sessionId,
          relativePath: "README.md",
          offset: 0,
        });
        if (chunk.kind !== "chunk") return assert.fail("Expected chunk");
        assert.equal(Buffer.from(chunk.contents, "base64").toString(), "public content");
        for (const relativePath of [".env", "../README.md", ".git/config"]) {
          assert.equal(
            (yield* request(token, {
              operation: "read",
              sessionId: snapshot.sessionId,
              relativePath,
              offset: 0,
            }).pipe(Effect.result))._tag,
            "Failure",
          );
        }
        yield* fs.writeFileString(`${test.cwd}/README.md`, "changed content");
        const ended = yield* request(token, {
          operation: "end",
          sessionId: snapshot.sessionId,
          validate: true,
        }).pipe(Effect.result);
        assert.equal(ended._tag, "Failure");
        if (ended._tag === "Failure") assert.equal(ended.failure.reason, "transfer");
        const replacement = yield* request(token, start);
        if (replacement.kind !== "snapshot") return assert.fail("Expected replacement snapshot");
        assert.notEqual(replacement.hash, snapshot.hash);
        assert.equal(
          (yield* request(token, {
            operation: "end",
            sessionId: replacement.sessionId,
            validate: true,
          })).kind,
          "ended",
        );
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "binds sessions to a member and credential, rechecks revocation, and replaces or expires abandoned snapshots",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Effect.gen(function* () {
        const token = yield* grant();
        const other = yield* grant("files", third);
        const snapshot = yield* request(token, start);
        if (snapshot.kind !== "snapshot") return assert.fail("Expected snapshot");
        const page = { operation: "entries", sessionId: snapshot.sessionId, cursor: 0 } as const;
        const foreign = yield* request(other, page, third).pipe(Effect.result);
        assert.equal(foreign._tag, "Failure");
        if (foreign._tag === "Failure") assert.equal(foreign.failure.reason, "session");
        const rotated = yield* grant();
        const revoked = yield* request(token, page).pipe(Effect.result);
        if (revoked._tag !== "Failure") return assert.fail("Expected revoked grant");
        assert.equal(revoked.failure.reason, "denied");
        const reused = yield* request(rotated, page).pipe(Effect.result);
        if (reused._tag !== "Failure") return assert.fail("Expected credential-bound session");
        assert.equal(reused.failure.reason, "session");
        const replacement = yield* request(rotated, start);
        if (replacement.kind !== "snapshot") return assert.fail("Expected replacement");
        assert.equal((yield* request(rotated, page).pipe(Effect.result))._tag, "Failure");
        yield* TestClock.adjust("6 minutes");
        const expired = yield* request(rotated, { ...page, sessionId: replacement.sessionId }).pipe(
          Effect.result,
        );
        if (expired._tag !== "Failure") return assert.fail("Expected expired session");
        assert.equal(expired.failure.reason, "session");
        const fresh = yield* request(rotated, start);
        if (fresh.kind !== "snapshot") return assert.fail("Expected fresh snapshot");
        test.setManifest({ ...base, members: [owner, third] });
        const removed = yield* request(rotated, { ...page, sessionId: fresh.sessionId }).pipe(
          Effect.result,
        );
        if (removed._tag !== "Failure") return assert.fail("Expected removed member denial");
        assert.equal(removed.failure.reason, "denied");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "fences stale revisions, remapped folders, pauses, archived projects and repository roots",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Effect.gen(function* () {
        const token = yield* grant();
        const snapshot = yield* request(token, start);
        if (snapshot.kind !== "snapshot") return assert.fail("Expected snapshot");
        const page = { operation: "entries", sessionId: snapshot.sessionId, cursor: 0 } as const;
        const expectReason = (body: typeof SharedProjectContentRequest.Type, reason: string) =>
          request(token, body).pipe(
            Effect.result,
            Effect.map((value) => {
              if (value._tag !== "Failure") return assert.fail("Expected blocked transfer");
              assert.equal(value.failure.reason, reason);
            }),
          );
        yield* expectReason({ ...start, expectedManifestRevision: 2 }, "stale");
        test.setBinding({ revision: 2 });
        yield* expectReason(page, "stale");
        test.setBinding({ paused: true });
        yield* expectReason(start, "unmapped");
        test.setBinding({ paused: false, detached: true });
        yield* expectReason(start, "unmapped");
        test.setBinding({ detached: false });
        test.setManifest({ ...base, archived: true });
        yield* expectReason(start, "unmapped");
        test.setManifest({ ...base, roots: base.roots.map((root) => ({ ...root, kind: "git" })) });
        yield* expectReason(start, "unsupported-root");
        test.setManifest(base);
        test.setRegisteredPath(`${test.cwd}/private-notes`);
        yield* expectReason(start, "stale");
        test.setRegisteredPath(test.cwd);
        test.setManifest({ ...base, revision: 2 });
        yield* expectReason(start, "stale");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
