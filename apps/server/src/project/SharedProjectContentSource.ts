import {
  SharedProjectContentError,
  ProjectFolderEntries,
  type SharedProjectContentRequest,
  type SharedProjectContentResponse,
  type SharedProjectError,
  type ProjectFolderEntry,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectFolderTransfer from "./ProjectFolderTransfer.ts";
import * as SharedProjectEnrollment from "./SharedProjectEnrollment.ts";
import * as SharedProjects from "./SharedProjects.ts";

interface Snapshot {
  readonly projectId: string;
  readonly destinationId: string;
  readonly credentialHash: string;
  readonly rootId: string;
  readonly path: string;
  readonly manifestRevision: number;
  readonly bindingRevision: number;
  readonly entries: ReadonlyArray<ProjectFolderEntry>;
  readonly transferId: string;
  touchedAt: number;
}

const encodeEntries = Schema.encodeEffect(Schema.fromJsonString(ProjectFolderEntries));

export class SharedProjectContentSource extends Context.Service<
  SharedProjectContentSource,
  {
    readonly request: (input: {
      readonly projectId: string;
      readonly destinationId: string;
      readonly token: string;
      readonly request: typeof SharedProjectContentRequest.Type;
    }) => Effect.Effect<
      typeof SharedProjectContentResponse.Type,
      SharedProjectError | SharedProjectContentError
    >;
  }
>()("t3/project/SharedProjectContentSource") {}

const make = Effect.gen(function* () {
  const enrollment = yield* SharedProjectEnrollment.SharedProjectEnrollment;
  const projects = yield* SharedProjects.SharedProjects;
  const localProjects = yield* ProjectStore.ProjectStoreV2;
  const transfer = yield* ProjectFolderTransfer.ProjectFolderTransfer;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  const gate = yield* Semaphore.make(1);
  const snapshots = new Map<string, Snapshot>();
  const ttl = 5 * 60_000;
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
    );
  const close = Effect.fn("SharedProjectContentSource.close")(function* (id: string) {
    const snapshot = snapshots.get(id);
    snapshots.delete(id);
    if (snapshot)
      yield* transfer
        .exportEnd({ transferId: snapshot.transferId, validate: false })
        .pipe(Effect.ignore);
  });
  const prune = Effect.gen(function* () {
    const now = clock.currentTimeMillisUnsafe();
    for (const [id, snapshot] of snapshots) if (now - snapshot.touchedAt >= ttl) yield* close(id);
  });
  yield* gate
    .withPermits(1)(prune)
    .pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
  yield* Effect.addFinalizer(() => Effect.forEach([...snapshots.keys()], close, { discard: true }));

  return SharedProjectContentSource.of({
    request: Effect.fn("SharedProjectContentSource.request")((input) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          // Recheck the grant on every page and chunk, including after rotation or membership removal.
          const manifest = yield* enrollment.authorizeContent({ ...input, history: false });
          if (manifest.archived)
            return yield* new SharedProjectContentError({ reason: "unmapped" });
          yield* prune;
          const binding = yield* projects.getBinding(input.projectId);
          if (!binding || binding.detached || binding.paused)
            return yield* new SharedProjectContentError({ reason: "unmapped" });
          if (binding.manifestRevision !== manifest.revision)
            return yield* new SharedProjectContentError({ reason: "stale" });
          const request = input.request;
          const credentialHash = yield* hash(input.token);
          const snapshot = "sessionId" in request ? snapshots.get(request.sessionId) : undefined;
          if (
            "sessionId" in request &&
            (!snapshot ||
              snapshot.projectId !== input.projectId ||
              snapshot.destinationId !== input.destinationId ||
              snapshot.credentialHash !== credentialHash)
          )
            return yield* new SharedProjectContentError({ reason: "session" });
          const rootId = "rootId" in request ? request.rootId : snapshot!.rootId;
          const root = manifest.roots.find((root) => root.id === rootId);
          const mapping = binding.roots.find((root) => root.rootId === rootId);
          if (!root || !mapping)
            return yield* new SharedProjectContentError({ reason: "unmapped" });
          if (root.kind !== "files")
            return yield* new SharedProjectContentError({ reason: "unsupported-root" });
          const project = yield* localProjects
            .getShell(mapping.projectId)
            .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "unmapped" })));
          if (Option.isNone(project))
            return yield* new SharedProjectContentError({ reason: "unmapped" });
          const path = yield* fs
            .realPath(project.value.workspaceRoot)
            .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "unmapped" })));
          if (
            path !== mapping.path ||
            (snapshot &&
              (snapshot.path !== path ||
                snapshot.manifestRevision !== manifest.revision ||
                snapshot.bindingRevision !== binding.revision))
          )
            return yield* new SharedProjectContentError({ reason: "stale" });
          if (
            "expectedManifestRevision" in request &&
            request.expectedManifestRevision !== manifest.revision
          )
            return yield* new SharedProjectContentError({ reason: "stale" });

          if (request.operation === "observe" || request.operation === "start") {
            const observation = yield* transfer
              .observeContent({
                cwd: path,
                observerId: `${input.projectId}/${rootId}`,
                contentPolicy: root.contentPolicy,
              })
              .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "transfer" })));
            const revision = {
              manifestRevision: manifest.revision,
              bindingRevision: binding.revision,
              rootId,
              observation,
            };
            if (request.operation === "observe") return { kind: "observation", ...revision };
            for (const [id, previous] of snapshots)
              if (
                previous.projectId === input.projectId &&
                previous.rootId === rootId &&
                previous.destinationId === input.destinationId
              )
                yield* close(id);
            if (snapshots.size >= 4)
              return yield* new SharedProjectContentError({ reason: "busy" });
            const exported = yield* transfer
              .exportFolder({ cwd: path, contentPolicy: root.contentPolicy })
              .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "transfer" })));
            return yield* Effect.gen(function* () {
              if (
                exported.entries.length > 100_000 ||
                exported.entries.reduce((total, entry) => total + entry.byteLength, 0) >
                  2 * 1024 ** 3
              )
                return yield* new SharedProjectContentError({ reason: "quota" });
              const entries = exported.entries.toSorted((a, b) =>
                a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
              );
              const encoded = yield* encodeEntries(entries).pipe(
                Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
              );
              const digest = yield* hash(encoded);
              const id = yield* crypto
                .randomUUIDv4()
                .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })));
              snapshots.set(id, {
                projectId: input.projectId,
                destinationId: input.destinationId,
                credentialHash,
                rootId,
                path,
                manifestRevision: manifest.revision,
                bindingRevision: binding.revision,
                entries,
                transferId: exported.transferId,
                touchedAt: clock.currentTimeMillisUnsafe(),
              });
              return {
                kind: "snapshot" as const,
                ...revision,
                sessionId: id,
                hash: digest,
                entryCount: entries.length,
              };
            }).pipe(
              Effect.onError(() =>
                transfer
                  .exportEnd({ transferId: exported.transferId, validate: false })
                  .pipe(Effect.ignore),
              ),
            );
          }

          if (!snapshot) return yield* new SharedProjectContentError({ reason: "session" });
          snapshot.touchedAt = clock.currentTimeMillisUnsafe();
          if (request.operation === "entries") {
            if (request.cursor > snapshot.entries.length)
              return yield* new SharedProjectContentError({ reason: "session" });
            const entries = snapshot.entries.slice(request.cursor, request.cursor + 256);
            const next = request.cursor + entries.length;
            return {
              kind: "entries",
              entries,
              nextCursor: next < snapshot.entries.length ? next : null,
            };
          }
          if (request.operation === "read") {
            const chunk = yield* transfer
              .read({
                transferId: snapshot.transferId,
                relativePath: request.relativePath,
                offset: request.offset,
              })
              .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "transfer" })));
            return { kind: "chunk", ...chunk };
          }
          snapshots.delete(request.sessionId);
          yield* transfer
            .exportEnd({ transferId: snapshot.transferId, validate: request.validate })
            .pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "transfer" })));
          return { kind: "ended" };
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(SharedProjectContentSource, make);
