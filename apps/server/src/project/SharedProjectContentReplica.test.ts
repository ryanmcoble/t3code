import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  SharedProjectError,
  type SharedProjectManifest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import { vi } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as Guard from "../workspace/WorkspaceMutationGuard.ts";
import * as Transfer from "./ProjectFolderTransfer.ts";
import * as Enrollment from "./SharedProjectEnrollment.ts";
import * as Source from "./SharedProjectContentSource.ts";
import * as Replica from "./SharedProjectContentReplica.ts";
import * as Store from "./SharedProjectContentStore.ts";
import * as SharedProjects from "./SharedProjects.ts";

const watches = vi.hoisted(() => new Map<string, (name: string) => void>());
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    watch: (root: string, _options: unknown, listener: (event: string, name: string) => void) => {
      watches.set(root, (name) => listener("change", name));
      const watcher = {
        close: () => {
          watches.delete(root);
        },
        unref: () => {},
        on: () => watcher,
      };
      return watcher;
    },
  };
});
const owner = EnvironmentId.make("owner");
const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const projectId = ProjectId.make("local");
const manifest: SharedProjectManifest = {
  id: "sample",
  name: "Sample",
  ownerEnvironmentId: owner,
  revision: 1,
  members: [owner, first, second],
  setupProfileId: null,
  archived: false,
  roots: [
    {
      id: "docs",
      name: "Docs",
      kind: "files",
      contentPolicy: { mode: "project-content", excludePaths: [] },
    },
  ],
};
const idle = Layer.succeed(Guard.WorkspaceMutationGuard, { withIdle: (_paths, effect) => effect });
const common = (
  cwd: string,
  environmentId: EnvironmentId,
  bindingRevision: () => number = () => 1,
) =>
  Layer.mergeAll(
    Layer.mock(SharedProjects.SharedProjects)({
      get: () => Effect.succeed(manifest),
      getBinding: () =>
        Effect.sync(() => ({
          sharedProjectId: manifest.id,
          environmentId,
          manifestRevision: 1,
          revision: bindingRevision(),
          detached: false,
          paused: false,
          roots: [{ rootId: "docs", projectId, path: cwd }],
        })),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      getShell: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Docs",
          workspaceRoot: cwd,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-11-11T00:00:00Z",
          updatedAt: "2026-11-11T00:00:00Z",
        }),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
    idle,
  );

it.effect(
  "converges selected members without a client, catches up after offline restart and retains both conflicting versions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-content-replica-test-" });
      const parent = yield* fs.realPath(temporary);
      const ownerRoot = `${parent}/owner-files`;
      yield* fs.makeDirectory(ownerRoot);
      yield* fs.writeFileString(`${ownerRoot}/README.md`, "owner version one");
      yield* fs.writeFileString(`${ownerRoot}/.env`, "owner secret");
      const ownerLayer = Source.layer.pipe(
        Layer.provideMerge(Enrollment.layer),
        Layer.provideMerge(Transfer.layer),
        Layer.provideMerge(common(ownerRoot, owner)),
        Layer.provide(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Owner must not fetch a peer")),
          ),
        ),
        Layer.provideMerge(Sqlite.layerFromPath(`${parent}/owner-home/state.sqlite`)),
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), `${parent}/owner-home`),
        ),
      );
      const ownerContext = yield* Layer.build(ownerLayer);
      const source = Context.get(ownerContext, Source.SharedProjectContentSource);
      const grants = Context.get(ownerContext, Enrollment.SharedProjectEnrollment);
      const member = (environmentId: EnvironmentId) =>
        Effect.gen(function* () {
          const cwd = `${parent}/${environmentId}-files`;
          yield* fs.makeDirectory(cwd);
          yield* fs.writeFileString(`${cwd}/.env`, `${environmentId} secret`);
          const granted = yield* grants.grant({
            sharedProjectId: manifest.id,
            destinationEnvironmentId: environmentId,
            access: "files",
            revoke: false,
          });
          let online = true;
          let enabled = true;
          let corruptSnapshot = false;
          let bindingRevision = 1;
          const layer = Replica.layer.pipe(
            Layer.provideMerge(Store.layer),
            Layer.provideMerge(Transfer.layer),
            Layer.provideMerge(common(cwd, environmentId, () => bindingRevision)),
            Layer.provideMerge(
              Layer.mock(Enrollment.SharedProjectEnrollment)({
                state: Effect.sync(() => ({
                  complete: true,
                  subscriptions: [
                    {
                      sharedProjectId: manifest.id,
                      ownerEnvironmentId: owner,
                      sourceUrl: "https://owner.test",
                      paused: false,
                      observedRevision: 1,
                      lastCheckedAt: null,
                      error: null,
                      receiveFiles: enabled,
                    },
                  ],
                })),
                contentRequest: (_projectId, request) =>
                  Effect.suspend(() =>
                    online
                      ? source
                          .request({
                            projectId: manifest.id,
                            destinationId: environmentId,
                            token: granted.token!,
                            request,
                          })
                          .pipe(
                            Effect.map((response) =>
                              corruptSnapshot && response.kind === "snapshot"
                                ? { ...response, hash: "0".repeat(64) }
                                : response,
                            ),
                          )
                      : Effect.fail(new SharedProjectError({ reason: "unreachable" })),
                  ),
              }),
            ),
            Layer.provideMerge(
              Sqlite.layerFromPath(`${parent}/${environmentId}-home/state.sqlite`),
            ),
            Layer.provideMerge(
              ServerConfig.ServerConfig.layerTest(process.cwd(), `${parent}/${environmentId}-home`),
            ),
          );
          const open = Effect.gen(function* () {
            const scope = yield* Scope.make();
            const context = yield* Layer.build(layer).pipe(
              Effect.provideService(Scope.Scope, scope),
            );
            return {
              replica: Context.get(context, Replica.SharedProjectContentReplica),
              store: Context.get(context, Store.SharedProjectContentStore),
              close: Scope.close(scope, Exit.void),
            };
          });
          return {
            cwd,
            open,
            setOnline: (value: boolean) => {
              online = value;
            },
            setEnabled: (value: boolean) => {
              enabled = value;
            },
            setCorruptSnapshot: (value: boolean) => {
              corruptSnapshot = value;
            },
            bumpBindingRevision: () => {
              bindingRevision++;
            },
          };
        });
      const a = yield* member(first);
      const b = yield* member(second);
      const firstServices = yield* a.open;
      const secondServices = yield* b.open;
      yield* Effect.addFinalizer(() => firstServices.close);
      yield* Effect.addFinalizer(() => secondServices.close);
      yield* firstServices.replica.reconcile;
      yield* secondServices.replica.reconcile;
      for (const target of [a, b]) {
        assert.equal(yield* fs.readFileString(`${target.cwd}/README.md`), "owner version one");
        assert.equal(
          yield* fs.readFileString(`${target.cwd}/.env`),
          `${target === a ? first : second} secret`,
        );
      }
      assert.equal((yield* firstServices.store.read(manifest.id, "docs"))?.record.phase, "current");
      assert.equal((yield* firstServices.replica.state(manifest.id)).roots[0]?.phase, "current");
      b.setOnline(false);
      yield* fs.writeFileString(`${ownerRoot}/README.md`, "owner version two");
      watches.get(ownerRoot)!("README.md");
      yield* firstServices.replica.reconcile;
      yield* secondServices.replica.reconcile;
      assert.equal(yield* fs.readFileString(`${a.cwd}/README.md`), "owner version two");
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "owner version one");
      const offline = yield* secondServices.store.read(manifest.id, "docs");
      assert.equal(offline?.record.phase, "error");
      assert.isNotNull(offline?.record.error);
      yield* secondServices.close;
      b.setOnline(true);
      const restarted = yield* b.open;
      yield* Effect.addFinalizer(() => restarted.close);
      yield* restarted.replica.reconcile;
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "owner version two");
      assert.equal((yield* restarted.store.read(manifest.id, "docs"))?.record.phase, "current");
      yield* fs.writeFileString(`${b.cwd}/README.md`, "member's distinct edit");
      yield* fs.writeFileString(`${b.cwd}/local-only.md`, "unpublished local addition");
      yield* fs.writeFileString(`${ownerRoot}/owner-addition.md`, "unrelated owner addition");
      watches.get(b.cwd)!("README.md");
      yield* fs.writeFileString(`${ownerRoot}/README.md`, "owner's distinct edit");
      watches.get(ownerRoot)!("README.md");
      b.setCorruptSnapshot(true);
      for (let attempt = 0; attempt < 5; attempt++) {
        const rejected = yield* restarted.replica.syncRoot(manifest.id, "docs").pipe(Effect.result);
        if (rejected._tag !== "Failure")
          return assert.fail("Expected snapshot integrity rejection");
        assert.equal(rejected.failure.reason, "transfer");
        assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "member's distinct edit");
      }
      b.setCorruptSnapshot(false);
      const conflict = yield* restarted.replica.syncRoot(manifest.id, "docs");
      assert.equal(conflict.phase, "conflict");
      assert.deepEqual(conflict.conflict?.paths, ["README.md"]);
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "member's distinct edit");
      if (!conflict.conflict) return assert.fail("Expected retained conflict");
      const readRetained = (retained: typeof conflict.conflict.local) =>
        Effect.gen(function* () {
          const hash = retained.chunks["README.md"]![0]!;
          return Buffer.from(yield* restarted.store.readChunk(hash), "base64").toString();
        });
      assert.equal(yield* readRetained(conflict.conflict.local), "member's distinct edit");
      assert.equal(yield* readRetained(conflict.conflict.remote), "owner's distinct edit");
      const review = yield* restarted.replica.conflictPage({
        sharedProjectId: manifest.id,
        rootId: "docs",
        cursor: 0,
      });
      assert.deepEqual(review.paths, ["README.md"]);
      const useOwner = {
        operation: "resolve",
        sharedProjectId: manifest.id,
        rootId: "docs",
        expectedGeneration: review.generation,
        choice: "owner",
      } as const;
      yield* fs.writeFileString(`${b.cwd}/README.md`, "edited after review");
      const stale = yield* restarted.replica.command(useOwner).pipe(Effect.result);
      if (stale._tag !== "Failure") return assert.fail("Expected post-review edit protection");
      assert.equal(stale.failure.reason, "stale");
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "edited after review");
      yield* fs.writeFileString(`${b.cwd}/README.md`, "member's distinct edit");
      yield* restarted.replica.command(useOwner);
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "owner's distinct edit");
      assert.equal(
        yield* fs.readFileString(`${b.cwd}/owner-addition.md`),
        "unrelated owner addition",
      );
      assert.equal(
        yield* fs.readFileString(`${b.cwd}/local-only.md`),
        "unpublished local addition",
      );
      assert.equal(yield* readRetained(conflict.conflict.local), "member's distinct edit");
      assert.equal((yield* restarted.replica.state(manifest.id)).roots[0]?.conflictCount, 0);
      yield* fs.writeFileString(`${b.cwd}/README.md`, "new work after recovery");
      watches.get(b.cwd)!("README.md");
      yield* restarted.replica.command(useOwner);
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "new work after recovery");
      yield* restarted.replica.syncRoot(manifest.id, "docs");
      b.bumpBindingRevision();
      assert.equal((yield* restarted.replica.syncRoot(manifest.id, "docs")).phase, "local-changes");
      yield* fs.writeFileString(`${ownerRoot}/README.md`, "another owner edit");
      yield* fs.writeFileString(
        `${ownerRoot}/second-addition.md`,
        "owner addition during local recovery",
      );
      watches.get(ownerRoot)!("README.md");
      yield* restarted.replica.syncRoot(manifest.id, "docs");
      const nextReview = yield* restarted.replica.conflictPage({
        sharedProjectId: manifest.id,
        rootId: "docs",
        cursor: 0,
      });
      yield* restarted.replica.command({
        ...useOwner,
        expectedGeneration: nextReview.generation,
        choice: "local",
      });
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "new work after recovery");
      assert.equal((yield* restarted.replica.state(manifest.id)).roots[0]?.phase, "local-changes");
      assert.equal(
        yield* fs.readFileString(`${b.cwd}/second-addition.md`),
        "owner addition during local recovery",
      );
      yield* fs.makeDirectory(`${b.cwd}/replacement`);
      yield* fs.writeFileString(`${b.cwd}/replacement/local.md`, "local subtree");
      yield* fs.writeFileString(`${ownerRoot}/replacement`, "owner file replaces subtree");
      watches.get(b.cwd)!("replacement");
      watches.get(ownerRoot)!("replacement");
      assert.equal((yield* restarted.replica.syncRoot(manifest.id, "docs")).phase, "conflict");
      const replacement = yield* restarted.replica.conflictPage({
        sharedProjectId: manifest.id,
        rootId: "docs",
        cursor: 0,
      });
      assert.deepEqual(replacement.paths, ["replacement"]);
      yield* restarted.replica.command({ ...useOwner, expectedGeneration: replacement.generation });
      assert.equal(yield* fs.readFileString(`${b.cwd}/replacement`), "owner file replaces subtree");
      assert.equal(
        yield* fs.readFileString(`${b.cwd}/local-only.md`),
        "unpublished local addition",
      );
      assert.equal(yield* fs.readFileString(`${b.cwd}/.env`), "second secret");
      b.setEnabled(false);
      assert.equal(
        (yield* restarted.replica.syncRoot(manifest.id, "docs").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(yield* fs.readFileString(`${b.cwd}/README.md`), "new work after recovery");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
