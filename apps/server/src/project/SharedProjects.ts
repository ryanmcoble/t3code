import {
  SharedProjectBinding,
  SharedProjectError,
  SharedProjectManifest,
  type SharedProjectBind,
  type SharedProjectPublish,
  type SharedProjectState,
} from "@t3tools/contracts";
import { compileProjectContentPolicy } from "@t3tools/shared/projectContentPolicy";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

export class SharedProjects extends Context.Service<
  SharedProjects,
  {
    readonly state: Effect.Effect<SharedProjectState, SharedProjectError>;
    readonly publish: (
      input: typeof SharedProjectPublish.Type,
    ) => Effect.Effect<SharedProjectManifest, SharedProjectError>;
    readonly bind: (
      input: typeof SharedProjectBind.Type,
    ) => Effect.Effect<SharedProjectBinding, SharedProjectError>;
    readonly unbind: (
      id: string,
      expectedRevision: number,
    ) => Effect.Effect<void, SharedProjectError>;
  }
>()("t3/project/SharedProjects") {}

const manifestCodec = Schema.fromJsonString(SharedProjectManifest);
const bindingCodec = Schema.fromJsonString(SharedProjectBinding);
const decodeManifest = Schema.decodeUnknownEffect(manifestCodec);
const decodeBinding = Schema.decodeUnknownEffect(bindingCodec);
const encodeManifest = Schema.encodeEffect(manifestCodec);
const encodeBinding = Schema.encodeEffect(bindingCodec);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const repositoryIdentity = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const home = yield* HostProcess.HomeDirectory;
  const gate = yield* Semaphore.make(1);
  const environmentId = yield* identity.getEnvironmentId;
  const latest = Effect.fn("SharedProjects.latest")(
    function* (id: string) {
      const rows = yield* sql<{
        readonly manifest: string;
      }>`SELECT manifest_json AS manifest FROM shared_project_revisions WHERE project_id=${id} ORDER BY revision DESC LIMIT 1`;
      return rows[0] ? yield* decodeManifest(rows[0].manifest) : null;
    },
    Effect.mapError(() => new SharedProjectError({ reason: "storage" })),
  );
  const validate = (input: typeof SharedProjectPublish.Type) => {
    const roots = input.roots.map((root) => root.id);
    return (
      roots.length > 0 &&
      new Set(roots).size === roots.length &&
      input.members.includes(environmentId) &&
      new Set(input.members).size === input.members.length &&
      input.roots.every(
        (root) =>
          compileProjectContentPolicy(root.contentPolicy) !== null &&
          (root.kind === "git" || root.repositoryKey === undefined),
      )
    );
  };
  const readBinding = Effect.fn("SharedProjects.readBinding")(
    function* (id: string) {
      const rows = yield* sql<{
        readonly binding: string;
      }>`SELECT binding_json AS binding FROM shared_project_bindings WHERE project_id=${id}`;
      return rows[0] ? yield* decodeBinding(rows[0].binding) : null;
    },
    Effect.mapError(() => new SharedProjectError({ reason: "storage" })),
  );
  const state = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly manifest: string;
    }>`SELECT r.manifest_json AS manifest FROM shared_project_revisions r JOIN (SELECT project_id,MAX(revision) AS revision FROM shared_project_revisions GROUP BY project_id) latest ON latest.project_id=r.project_id AND latest.revision=r.revision ORDER BY r.project_id LIMIT 201`;
    const bindings = yield* sql<{
      readonly binding: string;
    }>`SELECT binding_json AS binding FROM shared_project_bindings ORDER BY project_id LIMIT 201`;
    return {
      projects: yield* Effect.forEach(rows.slice(0, 200), (row) => decodeManifest(row.manifest)),
      bindings: yield* Effect.forEach(bindings.slice(0, 200), (row) => decodeBinding(row.binding)),
      complete: rows.length <= 200 && bindings.length <= 200,
    };
  }).pipe(Effect.mapError(() => new SharedProjectError({ reason: "storage" })));
  return SharedProjects.of({
    state,
    publish: Effect.fn("SharedProjects.publish")(function (input) {
      return gate.withPermits(1)(
        sql
          .withTransaction(
            Effect.gen(function* () {
              if (!validate(input))
                return yield* new SharedProjectError({ reason: "invalid-manifest" });
              const id =
                input.id ??
                (yield* crypto
                  .randomUUIDv4()
                  .pipe(Effect.mapError(() => new SharedProjectError({ reason: "storage" }))));
              const previous = yield* latest(id);
              if (previous && previous.ownerEnvironmentId !== environmentId)
                return yield* new SharedProjectError({ reason: "owner" });
              if ((previous?.revision ?? 0) !== input.expectedRevision)
                return yield* new SharedProjectError({ reason: "revision" });
              const manifest: SharedProjectManifest = {
                id,
                ownerEnvironmentId: environmentId,
                revision: input.expectedRevision + 1,
                name: input.name,
                roots: input.roots,
                members: input.members,
                setupProfileId: input.setupProfileId,
                archived: input.archived,
              };
              const encoded = yield* encodeManifest(manifest).pipe(
                Effect.mapError(() => new SharedProjectError({ reason: "invalid-manifest" })),
              );
              const now = yield* Clock.currentTimeMillis;
              yield* sql`INSERT INTO shared_project_revisions(project_id,revision,owner_environment_id,manifest_json,created_at) VALUES(${id},${manifest.revision},${environmentId},${encoded},${now})`.pipe(
                Effect.mapError(() => new SharedProjectError({ reason: "storage" })),
              );
              return manifest;
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "SharedProjectError"
                ? error
                : new SharedProjectError({ reason: "storage" }),
            ),
          ),
      );
    }),
    bind: Effect.fn("SharedProjects.bind")(function (input) {
      return gate.withPermits(1)(
        Effect.gen(function* () {
          const manifest = yield* latest(input.sharedProjectId);
          if (!manifest) return yield* new SharedProjectError({ reason: "not-found" });
          if (manifest.revision !== input.expectedRevision || manifest.archived)
            return yield* new SharedProjectError({ reason: "revision" });
          if (!manifest.members.includes(environmentId))
            return yield* new SharedProjectError({ reason: "membership" });
          const previous = yield* readBinding(manifest.id);
          if ((previous?.revision ?? 0) !== input.expectedBindingRevision)
            return yield* new SharedProjectError({ reason: "revision" });
          if (
            input.roots.length !== manifest.roots.length ||
            new Set(input.roots.map((root) => root.rootId)).size !== input.roots.length
          )
            return yield* new SharedProjectError({ reason: "invalid-root" });
          const roots = yield* Effect.forEach(input.roots, (root) =>
            Effect.gen(function* () {
              const definition = manifest.roots.find((candidate) => candidate.id === root.rootId);
              if (!definition) return yield* new SharedProjectError({ reason: "invalid-root" });
              const project = yield* projects
                .getShell(root.projectId)
                .pipe(Effect.mapError(() => new SharedProjectError({ reason: "invalid-root" })));
              if (Option.isNone(project))
                return yield* new SharedProjectError({ reason: "invalid-root" });
              const real = yield* fs
                .realPath(project.value.workspaceRoot)
                .pipe(Effect.mapError(() => new SharedProjectError({ reason: "invalid-root" })));
              if (path.parse(real).root === real || real === home)
                return yield* new SharedProjectError({ reason: "invalid-root" });
              yield* workspaces
                .assertContains(real)
                .pipe(Effect.mapError(() => new SharedProjectError({ reason: "invalid-root" })));
              const repository = yield* vcs
                .detect({ cwd: real })
                .pipe(Effect.mapError(() => new SharedProjectError({ reason: "root-kind" })));
              if ((definition.kind === "git") !== (repository !== null))
                return yield* new SharedProjectError({ reason: "root-kind" });
              if (
                repository &&
                (yield* fs
                  .realPath(repository.repository.rootPath)
                  .pipe(Effect.mapError(() => new SharedProjectError({ reason: "root-kind" })))) !==
                  real
              )
                return yield* new SharedProjectError({ reason: "root-kind" });
              if (definition.repositoryKey) {
                const resolved = yield* repositoryIdentity.resolve(real, { refresh: true });
                if (resolved?.canonicalKey !== definition.repositoryKey)
                  return yield* new SharedProjectError({ reason: "root-kind" });
              }
              return { rootId: root.rootId, projectId: root.projectId, path: real };
            }),
          );
          const portablePaths = roots.map((root) =>
            root.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(),
          );
          if (
            portablePaths.some((root, index) =>
              portablePaths.some(
                (other, otherIndex) =>
                  index !== otherIndex && (root === other || root.startsWith(`${other}/`)),
              ),
            )
          )
            return yield* new SharedProjectError({ reason: "invalid-root" });
          const binding: SharedProjectBinding = {
            sharedProjectId: manifest.id,
            environmentId,
            manifestRevision: manifest.revision,
            revision: input.expectedBindingRevision + 1,
            detached: false,
            roots,
            paused: input.paused,
          };
          const encoded = yield* encodeBinding(binding).pipe(
            Effect.mapError(() => new SharedProjectError({ reason: "storage" })),
          );
          const now = yield* Clock.currentTimeMillis;
          const saved = yield* sql<{
            readonly id: string;
          }>`INSERT INTO shared_project_bindings(project_id,binding_json,binding_revision,updated_at) VALUES(${manifest.id},${encoded},${binding.revision},${now}) ON CONFLICT(project_id) DO UPDATE SET binding_json=excluded.binding_json,binding_revision=excluded.binding_revision,updated_at=excluded.updated_at WHERE shared_project_bindings.binding_revision=${input.expectedBindingRevision} RETURNING project_id AS id`.pipe(
            Effect.mapError(() => new SharedProjectError({ reason: "storage" })),
          );
          if (!saved.length) return yield* new SharedProjectError({ reason: "revision" });
          return binding;
        }),
      );
    }),
    unbind: Effect.fn("SharedProjects.unbind")((id, expectedRevision) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* readBinding(id);
          if (!previous) return yield* new SharedProjectError({ reason: "not-found" });
          if (previous.detached && previous.revision === expectedRevision + 1) return;
          if (previous.revision !== expectedRevision)
            return yield* new SharedProjectError({ reason: "revision" });
          if (previous.detached) return;
          const binding = {
            ...previous,
            revision: previous.revision + 1,
            detached: true,
            paused: true,
          };
          const encoded = yield* encodeBinding(binding).pipe(
            Effect.mapError(() => new SharedProjectError({ reason: "storage" })),
          );
          const now = yield* Clock.currentTimeMillis;
          const saved = yield* sql<{
            readonly id: string;
          }>`UPDATE shared_project_bindings SET binding_json=${encoded},binding_revision=${binding.revision},updated_at=${now} WHERE project_id=${id} AND binding_revision=${expectedRevision} RETURNING project_id AS id`.pipe(
            Effect.mapError(() => new SharedProjectError({ reason: "storage" })),
          );
          if (!saved.length) return yield* new SharedProjectError({ reason: "revision" });
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(SharedProjects, make);
