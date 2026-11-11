import {
  PROJECT_FOLDER_CHUNK_BYTES,
  ProjectFolderEntries,
  SharedProjectContentError,
  SharedProjectError,
  ProjectFolderTransferError,
  type ProjectFolderEntry,
  type ProjectFolderContentPolicy,
  type SharedProjectContentResponse,
  type SharedProjectContentResolve,
  type SharedProjectContentState,
  type SharedProjectContentConflictInput,
  type SharedProjectContentConflictPage,
  type SharedProjectContentCommand,
  type SharedProjectRootBinding,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { folderEntryEqual, planFolderSync } from "@t3tools/shared/projectFolderMerge";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as WorkspaceMutationGuard from "../workspace/WorkspaceMutationGuard.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectFolderTransfer from "./ProjectFolderTransfer.ts";
import * as SharedProjectContentStore from "./SharedProjectContentStore.ts";
import * as SharedProjectEnrollment from "./SharedProjectEnrollment.ts";
import * as SharedProjects from "./SharedProjects.ts";

type ContentRecord = SharedProjectContentStore.SharedProjectContentRecord;
type Retained = typeof SharedProjectContentStore.RetainedProjectContent.Type;
type ReplicaError = SharedProjectError | SharedProjectContentError;
type RemoteSnapshot = Extract<
  typeof SharedProjectContentResponse.Type,
  { readonly kind: "snapshot" }
>;
const isContentError = Schema.is(SharedProjectContentError);
const isProjectError = Schema.is(SharedProjectError);
const isWorkspaceBusyError = Schema.is(WorkspaceMutationGuard.WorkspaceBusyError);
const isTransferError = Schema.is(ProjectFolderTransferError);
const encodeEntries = Schema.encodeEffect(Schema.fromJsonString(ProjectFolderEntries));

export class SharedProjectContentReplica extends Context.Service<
  SharedProjectContentReplica,
  {
    readonly syncRoot: (
      projectId: string,
      rootId: string,
    ) => Effect.Effect<ContentRecord, ReplicaError>;
    readonly reconcile: Effect.Effect<void, ReplicaError>;
    readonly state: (
      projectId: string,
    ) => Effect.Effect<typeof SharedProjectContentState.Type, ReplicaError>;
    readonly conflictPage: (
      input: typeof SharedProjectContentConflictInput.Type,
    ) => Effect.Effect<typeof SharedProjectContentConflictPage.Type, ReplicaError>;
    readonly command: (
      input: typeof SharedProjectContentCommand.Type,
    ) => Effect.Effect<void, ReplicaError>;
  }
>()("t3/project/SharedProjectContentReplica") {}

const make = Effect.gen(function* () {
  const projects = yield* SharedProjects.SharedProjects;
  const enrollment = yield* SharedProjectEnrollment.SharedProjectEnrollment;
  const transfer = yield* ProjectFolderTransfer.ProjectFolderTransfer;
  const store = yield* SharedProjectContentStore.SharedProjectContentStore;
  const guard = yield* WorkspaceMutationGuard.WorkspaceMutationGuard;
  const crypto = yield* Crypto.Crypto;
  const locks = yield* KeyedLock.make<string>();
  const localProjects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const mappingIdentity = Effect.fn("SharedProjectContentReplica.mappingIdentity")(function* (
    mapping: typeof SharedProjectRootBinding.Type,
  ) {
    const project = yield* localProjects
      .getShell(mapping.projectId)
      .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "unmapped" })));
    if (Option.isNone(project)) return yield* new SharedProjectContentError({ reason: "unmapped" });
    const real = yield* fs
      .realPath(project.value.workspaceRoot)
      .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "unmapped" })));
    if (real !== mapping.path) return yield* new SharedProjectContentError({ reason: "stale" });
    const stat = yield* fs
      .stat(real)
      .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "unmapped" })));
    if (stat.type !== "Directory" || Option.isNone(stat.ino))
      return yield* new SharedProjectContentError({ reason: "unmapped" });
    return `${stat.dev}:${stat.ino.value}`;
  });
  const normalizeError = (cause: unknown): ReplicaError => {
    if (isContentError(cause) || isProjectError(cause)) return cause;
    if (isWorkspaceBusyError(cause))
      return new SharedProjectContentError({
        reason: cause.reason === "active" ? "busy" : "activity-unavailable",
      });
    if (isTransferError(cause)) {
      if (cause.reason === "busy") return new SharedProjectContentError({ reason: "busy" });
      if (cause.reason === "observation_limit")
        return new SharedProjectContentError({ reason: "observation-limit" });
    }
    return new SharedProjectContentError({ reason: "transfer" });
  };
  const sameEntries = (
    left: ReadonlyArray<ProjectFolderEntry>,
    right: ReadonlyArray<ProjectFolderEntry>,
  ) => {
    const byPath = new Map(right.map((entry) => [entry.path, entry]));
    return (
      left.length === right.length &&
      left.every((entry) => folderEntryEqual(entry, byPath.get(entry.path)))
    );
  };
  const stageRetained = Effect.fn("SharedProjectContentReplica.stageRetained")(function* (
    cwd: string,
    entries: ReadonlyArray<ProjectFolderEntry>,
    previousEntries: ReadonlyArray<ProjectFolderEntry>,
    contentPolicy: ProjectFolderContentPolicy,
    copies: ReadonlyArray<Retained>,
  ) {
    const imported = yield* transfer
      .importFolder({
        destinationPath: cwd,
        entries,
        previousEntries,
        contentPolicy,
        incremental: true,
      })
      .pipe(Effect.mapError(normalizeError));
    return yield* Effect.gen(function* () {
      const before = new Map(previousEntries.map((entry) => [entry.path, entry]));
      const cached = new Map(
        copies.flatMap((copy) =>
          copy.entries
            .filter((entry) => entry.kind === "file" && entry.hash)
            .map(
              (entry) =>
                [
                  entry.hash,
                  Object.hasOwn(copy.chunks, entry.path) ? copy.chunks[entry.path] : undefined,
                ] as const,
            ),
        ),
      );
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        const existing = before.get(entry.path);
        if (
          existing?.kind === "file" &&
          entry.hash !== undefined &&
          entry.hash === existing.hash &&
          entry.byteLength === existing.byteLength
        )
          continue;
        const hashes = entry.hash ? cached.get(entry.hash) : undefined;
        if (!hashes || hashes.length !== Math.ceil(entry.byteLength / PROJECT_FOLDER_CHUNK_BYTES))
          return yield* new SharedProjectContentError({ reason: "transfer" });
        for (let index = 0; index < hashes.length; index++) {
          const contents = yield* store.readChunk(hashes[index]!);
          yield* transfer
            .write({
              transferId: imported.transferId,
              relativePath: entry.path,
              offset: index * PROJECT_FOLDER_CHUNK_BYTES,
              contents,
            })
            .pipe(Effect.mapError(normalizeError));
        }
      }
      return imported;
    }).pipe(
      Effect.onError(() =>
        transfer.cancel({ transferId: imported.transferId }).pipe(Effect.ignore),
      ),
    );
  });
  const retain = Effect.fn("SharedProjectContentReplica.retain")(function* (
    entries: ReadonlyArray<ProjectFolderEntry>,
    read: (path: string, offset: number) => Effect.Effect<string, ReplicaError>,
    previous: Retained | null,
  ) {
    const reusable = new Map(
      previous?.entries
        .filter((entry) => entry.kind === "file" && entry.hash)
        .map((entry) => [
          entry.hash,
          Object.hasOwn(previous.chunks, entry.path) ? previous.chunks[entry.path] : undefined,
        ]),
    );
    const chunks = new Map<string, ReadonlyArray<string>>();
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      const cached = entry.hash ? reusable.get(entry.hash) : undefined;
      if (cached) {
        chunks.set(entry.path, cached);
        continue;
      }
      const hashes: string[] = [];
      for (let offset = 0; offset < entry.byteLength; offset += PROJECT_FOLDER_CHUNK_BYTES) {
        const contents = yield* read(entry.path, offset);
        if (
          Buffer.from(contents, "base64").length !==
          Math.min(PROJECT_FOLDER_CHUNK_BYTES, entry.byteLength - offset)
        )
          return yield* new SharedProjectContentError({ reason: "transfer" });
        hashes.push(yield* store.putChunk(contents));
      }
      chunks.set(entry.path, hashes);
    }
    const retained: Retained = { entries, chunks: Object.fromEntries(chunks) };
    yield* store.validateRetained(retained);
    return retained;
  });
  const readRemoteEntries = Effect.fn("SharedProjectContentReplica.readRemoteEntries")(function* (
    projectId: string,
    snapshot: RemoteSnapshot,
    contentPolicy: ProjectFolderContentPolicy,
  ) {
    const entries: ProjectFolderEntry[] = [];
    let cursor = 0;
    while (true) {
      const page = yield* enrollment.contentRequest(projectId, {
        operation: "entries",
        sessionId: snapshot.sessionId,
        cursor,
      });
      if (page.kind !== "entries" || entries.length + page.entries.length > snapshot.entryCount)
        return yield* new SharedProjectContentError({ reason: "transfer" });
      entries.push(...page.entries);
      if (page.nextCursor === null) break;
      if (page.nextCursor !== entries.length || page.nextCursor <= cursor)
        return yield* new SharedProjectContentError({ reason: "transfer" });
      cursor = page.nextCursor;
    }
    if (entries.length !== snapshot.entryCount)
      return yield* new SharedProjectContentError({ reason: "transfer" });
    yield* transfer
      .validateEntries({ entries, contentPolicy })
      .pipe(Effect.mapError(normalizeError));
    const encoded = yield* encodeEntries(entries).pipe(Effect.mapError(normalizeError));
    if (
      encoded.length > 32 * 1024 ** 2 ||
      entries.reduce((sum, entry) => sum + entry.byteLength, 0) > 2 * 1024 ** 3
    )
      return yield* new SharedProjectContentError({ reason: "quota" });
    const bytes = new TextEncoder().encode(encoded);
    if (bytes.length > 32 * 1024 ** 2)
      return yield* new SharedProjectContentError({ reason: "quota" });
    const hash = yield* crypto
      .digest("SHA-256", bytes)
      .pipe(Effect.map(Hex.encode), Effect.mapError(normalizeError));
    if (hash !== snapshot.hash) return yield* new SharedProjectContentError({ reason: "transfer" });
    return { entries, hash };
  });
  const subscribed = Effect.fn("SharedProjectContentReplica.subscribed")(function* (
    projectId: string,
  ) {
    const subscription = (yield* enrollment.state).subscriptions.find(
      (value) => value.sharedProjectId === projectId,
    );
    if (!subscription?.receiveFiles || subscription.paused)
      return yield* new SharedProjectContentError({ reason: "unmapped" });
    return subscription;
  });
  const recordFailure = Effect.fn("SharedProjectContentReplica.recordFailure")(function* (
    projectId: string,
    rootId: string,
    error: ReplicaError,
  ) {
    const saved = yield* store.read(projectId, rootId);
    const manifest = yield* projects.get(projectId);
    const binding = yield* projects.getBinding(projectId);
    if (!binding) return;
    const previous = saved?.record;
    const phase =
      error.reason === "busy" || error.reason === "activity-unavailable"
        ? ("waiting" as const)
        : ("error" as const);
    if (previous?.phase === phase && previous.error === error.message) return;
    yield* store.save(
      projectId,
      rootId,
      saved?.generation ?? 0,
      previous
        ? { ...previous, phase, error: error.message }
        : {
            manifestRevision: manifest.revision,
            bindingRevision: binding.revision,
            phase,
            sourceHash: null,
            sourceObservation: null,
            localObservation: null,
            baseline: [],
            source: null,
            conflict: null,
            error: error.message,
          },
    );
  });
  const syncRoot = Effect.fn("SharedProjectContentReplica.syncRoot")(
    (projectId: string, rootId: string) =>
      locks.withLock(
        `${projectId}/${rootId}`,
        Effect.gen(function* () {
          yield* subscribed(projectId);
          const manifest = yield* projects.get(projectId);
          const binding = yield* projects.getBinding(projectId);
          const root = manifest.roots.find((value) => value.id === rootId);
          const mapping = binding?.roots.find((value) => value.rootId === rootId);
          if (
            manifest.archived ||
            !binding ||
            binding.detached ||
            binding.paused ||
            !root ||
            !mapping
          )
            return yield* new SharedProjectContentError({ reason: "unmapped" });
          if (binding.manifestRevision !== manifest.revision)
            return yield* new SharedProjectContentError({ reason: "stale" });
          if (root.kind !== "files")
            return yield* new SharedProjectContentError({ reason: "unsupported-root" });
          const saved = yield* store.read(projectId, rootId);
          const identity = yield* mappingIdentity(mapping);
          const workspaceIdentities = yield* Effect.forEach(binding.roots, mappingIdentity);
          let generation = saved?.generation ?? 0;
          const previous = saved?.record;
          const sameBinding =
            previous?.bindingRevision === binding.revision &&
            previous.manifestRevision === manifest.revision;
          const sameWorkspace =
            previous?.localPath === undefined
              ? sameBinding
              : previous.localPath === mapping.path &&
                previous.localProjectId === mapping.projectId &&
                previous.localIdentity === identity;
          const baseline = sameWorkspace ? previous!.baseline : [];
          const observationInput = {
            cwd: mapping.path,
            observerId: `${projectId}/${rootId}/replica`,
            contentPolicy: root.contentPolicy,
          };
          const localObservation = yield* transfer
            .observeContent(observationInput)
            .pipe(Effect.mapError(normalizeError));
          const observed = yield* enrollment.contentRequest(projectId, {
            operation: "observe",
            rootId,
            expectedManifestRevision: manifest.revision,
          });
          if (
            observed.kind !== "observation" ||
            observed.rootId !== rootId ||
            observed.manifestRevision !== manifest.revision
          )
            return yield* new SharedProjectContentError({ reason: "transfer" });
          if (
            sameBinding &&
            sameWorkspace &&
            previous.sourceObservation === observed.observation &&
            previous.localObservation === localObservation &&
            (previous.phase === "current" ||
              previous.phase === "local-changes" ||
              previous.phase === "conflict")
          )
            return previous;

          const exported = yield* enrollment.contentRequest(projectId, {
            operation: "start",
            rootId,
            expectedManifestRevision: manifest.revision,
          });
          if (exported.kind !== "snapshot")
            return yield* new SharedProjectContentError({ reason: "transfer" });
          let sourceEnded = false;
          return yield* Effect.gen(function* () {
            if (exported.rootId !== rootId || exported.manifestRevision !== manifest.revision)
              return yield* new SharedProjectContentError({ reason: "transfer" });
            if (exported.entryCount > 100_000)
              return yield* new SharedProjectContentError({ reason: "quota" });
            const { entries: remote, hash } = yield* readRemoteEntries(
              projectId,
              exported,
              root.contentPolicy,
            );
            const source = yield* retain(
              remote,
              (relativePath, offset) =>
                enrollment
                  .contentRequest(projectId, {
                    operation: "read",
                    sessionId: exported.sessionId,
                    relativePath,
                    offset,
                  })
                  .pipe(
                    Effect.flatMap((response) =>
                      response.kind === "chunk"
                        ? Effect.succeed(response.contents)
                        : Effect.fail(new SharedProjectContentError({ reason: "transfer" })),
                    ),
                  ),
              previous?.source ?? null,
            );
            const local = yield* transfer
              .exportFolder({ cwd: mapping.path, contentPolicy: root.contentPolicy })
              .pipe(Effect.mapError(normalizeError));
            let localEnded = false;
            return yield* Effect.gen(function* () {
              const plan = planFolderSync(baseline, local.entries, remote);
              const localCopy = plan.conflicts.length
                ? yield* retain(
                    local.entries,
                    (relativePath, offset) =>
                      transfer.read({ transferId: local.transferId, relativePath, offset }).pipe(
                        Effect.map((value) => value.contents),
                        Effect.mapError(normalizeError),
                      ),
                    previous?.conflict?.local ?? null,
                  )
                : null;
              yield* transfer
                .exportEnd({ transferId: local.transferId, validate: true })
                .pipe(Effect.mapError(normalizeError));
              localEnded = true;
              const ended = yield* enrollment.contentRequest(projectId, {
                operation: "end",
                sessionId: exported.sessionId,
                validate: true,
              });
              if (ended.kind !== "ended")
                return yield* new SharedProjectContentError({ reason: "transfer" });
              sourceEnded = true;
              const receipt: ContentRecord = {
                manifestRevision: manifest.revision,
                bindingRevision: binding.revision,
                phase: "waiting",
                sourceHash: hash,
                sourceObservation: exported.observation,
                localObservation,
                baseline,
                source,
                conflict: localCopy
                  ? { paths: plan.conflicts, local: localCopy, remote: source }
                  : null,
                error: null,
                localPath: mapping.path,
                localProjectId: mapping.projectId,
                localIdentity: identity,
              };
              // Preserve validated source bytes and both conflict versions before changing the destination.
              generation = yield* store.save(projectId, rootId, generation, receipt);
              if (localCopy) {
                const conflicted = { ...receipt, phase: "conflict" as const };
                yield* store.save(projectId, rootId, generation, conflicted);
                return conflicted;
              }
              const entries = plan.merged.map((value) => value.entry);
              const imported = yield* stageRetained(
                mapping.path,
                entries,
                local.entries,
                root.contentPolicy,
                [source],
              );
              return yield* guard
                .withIdle(
                  binding.roots.map((root) => root.path),
                  Effect.gen(function* () {
                    yield* subscribed(projectId);
                    const fresh = yield* projects.getBinding(projectId);
                    if (
                      fresh?.revision !== binding.revision ||
                      fresh.detached ||
                      fresh.paused ||
                      (yield* projects.get(projectId)).revision !== manifest.revision
                    )
                      return yield* new SharedProjectContentError({ reason: "stale" });
                    for (let index = 0; index < binding.roots.length; index++)
                      if (
                        (yield* mappingIdentity(binding.roots[index]!)) !==
                        workspaceIdentities[index]
                      )
                        return yield* new SharedProjectContentError({ reason: "stale" });
                    yield* transfer
                      .finish({ transferId: imported.transferId })
                      .pipe(Effect.mapError(normalizeError));
                    const changed = !sameEntries(entries, remote);
                    const applied: ContentRecord = {
                      ...receipt,
                      baseline: remote,
                      phase: changed ? "local-changes" : "current",
                      localObservation: yield* transfer
                        .observeContent(observationInput)
                        .pipe(Effect.mapError(normalizeError)),
                    };
                    yield* store.save(projectId, rootId, generation, applied);
                    return applied;
                  }),
                )
                .pipe(
                  Effect.mapError(normalizeError),
                  Effect.ensuring(
                    transfer.cancel({ transferId: imported.transferId }).pipe(Effect.ignore),
                  ),
                );
            }).pipe(
              Effect.ensuring(
                Effect.suspend(() =>
                  localEnded
                    ? Effect.void
                    : transfer
                        .exportEnd({ transferId: local.transferId, validate: false })
                        .pipe(Effect.ignore),
                ),
              ),
            );
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                sourceEnded
                  ? Effect.void
                  : enrollment
                      .contentRequest(projectId, {
                        operation: "end",
                        sessionId: exported.sessionId,
                        validate: false,
                      })
                      .pipe(Effect.ignore),
              ),
            ),
          );
        }).pipe(
          Effect.tapError((error) => recordFailure(projectId, rootId, error).pipe(Effect.ignore)),
        ),
      ),
  );
  const resolve = Effect.fn("SharedProjectContentReplica.resolve")(
    (input: typeof SharedProjectContentResolve.Type) =>
      locks.withLock(
        `${input.sharedProjectId}/${input.rootId}`,
        Effect.gen(function* () {
          const saved = yield* store.read(input.sharedProjectId, input.rootId);
          if (!saved) return yield* new SharedProjectContentError({ reason: "stale" });
          if (
            !saved.record.conflict &&
            saved.record.resolution?.fromGeneration === input.expectedGeneration &&
            saved.record.resolution.choice === input.choice
          )
            return;
          if (saved.generation !== input.expectedGeneration || !saved.record.conflict)
            return yield* new SharedProjectContentError({ reason: "stale" });
          const conflict = saved.record.conflict;
          yield* store.validateRetained(conflict.local);
          yield* store.validateRetained(conflict.remote);
          const manifest = yield* projects.get(input.sharedProjectId);
          const binding = yield* projects.getBinding(input.sharedProjectId);
          const root = manifest.roots.find((value) => value.id === input.rootId);
          const mapping = binding?.roots.find((value) => value.rootId === input.rootId);
          if (
            manifest.archived ||
            !binding ||
            binding.detached ||
            binding.paused ||
            !root ||
            !mapping ||
            manifest.revision !== saved.record.manifestRevision ||
            binding.revision !== saved.record.bindingRevision
          )
            return yield* new SharedProjectContentError({ reason: "stale" });
          return yield* guard
            .withIdle(
              binding.roots.map((root) => root.path),
              Effect.gen(function* () {
                const fresh = yield* projects.getBinding(input.sharedProjectId);
                const identity = yield* mappingIdentity(mapping);
                if (
                  fresh?.revision !== binding.revision ||
                  (yield* projects.get(input.sharedProjectId)).revision !== manifest.revision
                )
                  return yield* new SharedProjectContentError({ reason: "stale" });
                if (
                  saved.record.localIdentity !== undefined &&
                  saved.record.localIdentity !== identity
                )
                  return yield* new SharedProjectContentError({ reason: "stale" });
                const local = yield* transfer
                  .exportFolder({ cwd: mapping.path, contentPolicy: root.contentPolicy })
                  .pipe(Effect.mapError(normalizeError));
                return yield* Effect.gen(function* () {
                  if (!sameEntries(local.entries, conflict.local.entries))
                    return yield* new SharedProjectContentError({ reason: "stale" });
                  const affected = (entry: ProjectFolderEntry) =>
                    conflict.paths.some((value) => {
                      const path = entry.path.toLowerCase();
                      const changed = value.toLowerCase();
                      return path === changed || path.startsWith(`${changed}/`);
                    });
                  const automatic = planFolderSync(
                    saved.record.baseline,
                    conflict.local.entries,
                    conflict.remote.entries,
                  );
                  const selected = input.choice === "local" ? conflict.local : conflict.remote;
                  const entries = [
                    ...automatic.merged
                      .map((value) => value.entry)
                      .filter((entry) => !affected(entry)),
                    ...selected.entries.filter(affected),
                  ];
                  yield* transfer
                    .validateEntries({ entries, contentPolicy: root.contentPolicy })
                    .pipe(Effect.mapError(normalizeError));
                  yield* transfer
                    .exportEnd({ transferId: local.transferId, validate: true })
                    .pipe(Effect.mapError(normalizeError));
                  if (!sameEntries(entries, local.entries)) {
                    const imported = yield* stageRetained(
                      mapping.path,
                      entries,
                      local.entries,
                      root.contentPolicy,
                      [conflict.local, conflict.remote],
                    );
                    yield* transfer
                      .finish({ transferId: imported.transferId })
                      .pipe(
                        Effect.mapError(normalizeError),
                        Effect.ensuring(
                          transfer.cancel({ transferId: imported.transferId }).pipe(Effect.ignore),
                        ),
                      );
                  }
                  const localObservation = yield* transfer
                    .observeContent({
                      cwd: mapping.path,
                      observerId: `${input.sharedProjectId}/${input.rootId}/replica`,
                      contentPolicy: root.contentPolicy,
                    })
                    .pipe(Effect.mapError(normalizeError));
                  yield* store.save(input.sharedProjectId, input.rootId, saved.generation, {
                    ...saved.record,
                    baseline: conflict.remote.entries,
                    source: conflict.remote,
                    phase: sameEntries(entries, conflict.remote.entries)
                      ? "current"
                      : "local-changes",
                    conflict: null,
                    error: null,
                    localObservation,
                    resolution: { fromGeneration: input.expectedGeneration, choice: input.choice },
                  });
                }).pipe(
                  Effect.ensuring(
                    transfer
                      .exportEnd({ transferId: local.transferId, validate: false })
                      .pipe(Effect.ignore),
                  ),
                );
              }),
            )
            .pipe(Effect.mapError(normalizeError));
        }),
      ),
  );
  return SharedProjectContentReplica.of({
    syncRoot,
    state: Effect.fn("SharedProjectContentReplica.state")(function* (projectId) {
      const manifest = yield* projects.get(projectId);
      return {
        roots: yield* store.receipts(
          projectId,
          manifest.roots.map((root) => root.id),
        ),
      };
    }),
    conflictPage: Effect.fn("SharedProjectContentReplica.conflictPage")(function* (input) {
      const saved = yield* store.read(input.sharedProjectId, input.rootId);
      if (!saved?.record.conflict || input.cursor > saved.record.conflict.paths.length)
        return yield* new SharedProjectContentError({ reason: "stale" });
      const paths = saved.record.conflict.paths.slice(input.cursor, input.cursor + 64);
      const next = input.cursor + paths.length;
      return {
        generation: saved.generation,
        paths,
        total: saved.record.conflict.paths.length,
        nextCursor: next < saved.record.conflict.paths.length ? next : null,
      };
    }),
    command: Effect.fn("SharedProjectContentReplica.command")((input) =>
      input.operation === "refresh"
        ? syncRoot(input.sharedProjectId, input.rootId).pipe(Effect.asVoid)
        : resolve(input),
    ),
    reconcile: Effect.gen(function* () {
      for (const subscription of (yield* enrollment.state).subscriptions) {
        if (subscription.paused || !subscription.receiveFiles) continue;
        const manifest = yield* projects.get(subscription.sharedProjectId);
        for (const root of manifest.roots)
          yield* syncRoot(manifest.id, root.id).pipe(
            Effect.catch((error) =>
              Effect.logDebug("Shared project content preparation is waiting", {
                reason: error.reason,
                projectId: manifest.id,
                rootId: root.id,
              }),
            ),
          );
      }
    }),
  });
});

export const layer = Layer.effect(SharedProjectContentReplica, make);
export const start = Effect.gen(function* () {
  const replica = yield* SharedProjectContentReplica;
  yield* replica.reconcile.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Shared project content reconciliation failed", { reason: error.reason }),
    ),
    Effect.repeat(Schedule.spaced("15 seconds")),
    Effect.forkScoped,
  );
});
