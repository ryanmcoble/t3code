import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, type SharedProjectPublish } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as SharedProjects from "./SharedProjects.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const owner = EnvironmentId.make("owner");
const peer = EnvironmentId.make("peer");
const third = EnvironmentId.make("third");
const rootA = ProjectId.make("project-a");
const rootB = ProjectId.make("project-b");
const draft: typeof SharedProjectPublish.Type = {
  expectedRevision: 0,
  name: "Multi-root sample",
  members: [owner, peer, third],
  setupProfileId: null,
  archived: false,
  roots: [
    {
      id: "api",
      name: "API",
      kind: "files",
      contentPolicy: { mode: "project-content", excludePaths: [] },
    },
    {
      id: "docs",
      name: "Documents",
      kind: "files",
      contentPolicy: { mode: "project-content", excludePaths: [] },
    },
  ],
};
const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const parent = yield* fs.makeTempDirectoryScoped();
  const first = `${parent}/api`;
  const second = `${parent}/docs`;
  yield* fs.makeDirectory(first);
  yield* fs.makeDirectory(second);
  const paths = new Map([
    [rootA, first],
    [rootB, second],
  ]);
  return SharedProjects.layer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(owner),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: (id) =>
          Effect.succeed(Option.fromNullishOr(paths.get(id))).pipe(
            Effect.map((found) =>
              Option.map(found, (workspaceRoot) => ({
                id,
                title: id,
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-11-11T00:00:00Z",
                updatedAt: "2026-11-11T00:00:00Z",
              })),
            ),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
    ),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
  );
});

it.effect(
  "preserves stable project/root identity, explicit three-member selection and revision fencing",
  () =>
    Effect.gen(function* () {
      const layer = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* SharedProjects.SharedProjects;
        const original = yield* service.publish(draft);
        const separate = yield* service.publish(draft);
        assert.notEqual(original.id, separate.id);
        assert.deepEqual(original.members, [owner, peer, third]);
        const updated = yield* service.publish({
          ...draft,
          id: original.id,
          expectedRevision: 1,
          name: "Renamed sample",
          members: [owner, third],
        });
        assert.equal(updated.id, original.id);
        assert.deepEqual(
          updated.roots.map((root) => root.id),
          ["api", "docs"],
        );
        assert.equal(updated.revision, 2);
        const stale = yield* service
          .publish({ ...draft, id: original.id, expectedRevision: 1 })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") assert.equal(stale.failure.reason, "revision");
        const invalidOwner = yield* service
          .publish({ ...draft, members: [peer] })
          .pipe(Effect.result);
        assert.equal(invalidOwner._tag, "Failure");
        const duplicates = yield* service
          .publish({ ...draft, roots: [draft.roots[0]!, draft.roots[0]!] })
          .pipe(Effect.result);
        assert.equal(duplicates._tag, "Failure");
        const state = yield* service.state;
        assert.equal(state.projects.length, 2);
        assert.equal(state.projects.find((project) => project.id === original.id)?.revision, 2);
        assert.isTrue(state.complete);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.effect(
  "binds distinct registered local roots without putting paths in the portable manifest and rejects stale, overlapping or wrong-kind mappings",
  () =>
    Effect.gen(function* () {
      const layer = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* SharedProjects.SharedProjects;
        const manifest = yield* service.publish(draft);
        const roots = [
          { rootId: "api", projectId: rootA },
          { rootId: "docs", projectId: rootB },
        ];
        const binding = yield* service.bind({
          sharedProjectId: manifest.id,
          expectedRevision: 1,
          expectedBindingRevision: 0,
          roots,
          paused: true,
        });
        assert.equal(binding.environmentId, owner);
        assert.equal(binding.manifestRevision, 1);
        assert.isTrue(binding.paused);
        assert.equal(binding.roots.length, 2);
        assert.isFalse("path" in manifest.roots[0]!);
        const overlapping = yield* service
          .bind({
            sharedProjectId: manifest.id,
            expectedRevision: 1,
            expectedBindingRevision: 1,
            roots: [
              { rootId: "api", projectId: rootA },
              { rootId: "docs", projectId: rootA },
            ],
            paused: false,
          })
          .pipe(Effect.result);
        assert.equal(overlapping._tag, "Failure");
        const stale = yield* service
          .bind({
            sharedProjectId: manifest.id,
            expectedRevision: 2,
            expectedBindingRevision: 0,
            roots,
            paused: false,
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        const git = yield* service.publish({
          ...draft,
          roots: [{ ...draft.roots[0]!, kind: "git" }],
        });
        const mismatch = yield* service
          .bind({
            sharedProjectId: git.id,
            expectedRevision: 1,
            expectedBindingRevision: 0,
            roots: [{ rootId: "api", projectId: rootA }],
            paused: false,
          })
          .pipe(Effect.result);
        assert.equal(mismatch._tag, "Failure");
        if (mismatch._tag === "Failure") assert.equal(mismatch.failure.reason, "root-kind");
        const staleMapping = yield* service
          .bind({
            sharedProjectId: manifest.id,
            expectedRevision: 1,
            expectedBindingRevision: 0,
            roots,
            paused: false,
          })
          .pipe(Effect.result);
        assert.equal(staleMapping._tag, "Failure");
        if (staleMapping._tag === "Failure") assert.equal(staleMapping.failure.reason, "revision");
        yield* service.unbind(manifest.id, 1);
        yield* service.unbind(manifest.id, 1);
        const rebound = yield* service.bind({
          sharedProjectId: manifest.id,
          expectedRevision: 1,
          expectedBindingRevision: 2,
          roots,
          paused: false,
        });
        assert.equal(rebound.revision, 3);
        const staleDetach = yield* service.unbind(manifest.id, 1).pipe(Effect.result);
        assert.equal(staleDetach._tag, "Failure");
        yield* service.unbind(manifest.id, 3);
        assert.isTrue((yield* service.state).bindings[0]!.detached);
        assert.equal((yield* service.state).projects.length, 2);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
