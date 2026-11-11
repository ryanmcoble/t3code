// @effect-diagnostics nodeBuiltinImport:off -- Private chunk files use no-follow opens, exclusive staging and disk headroom checks.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import {
  PROJECT_FOLDER_CHUNK_BYTES,
  ProjectFolderEntries,
  SharedProjectContentError,
  PositiveInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const RetainedProjectContent = Schema.Struct({
  entries: ProjectFolderEntries,
  chunks: Schema.Record(Schema.String, Schema.Array(Digest)),
});
export const SharedProjectContentRecord = Schema.Struct({
  manifestRevision: PositiveInt,
  bindingRevision: PositiveInt,
  phase: Schema.Literals(["current", "local-changes", "conflict", "waiting", "error"]),
  sourceHash: Schema.NullOr(Digest),
  sourceObservation: Schema.NullOr(Schema.String),
  localObservation: Schema.NullOr(Schema.String),
  baseline: ProjectFolderEntries,
  source: Schema.NullOr(RetainedProjectContent),
  conflict: Schema.NullOr(
    Schema.Struct({
      paths: Schema.Array(Schema.String),
      local: RetainedProjectContent,
      remote: RetainedProjectContent,
    }),
  ),
  error: Schema.NullOr(Schema.String),
});
export type SharedProjectContentRecord = typeof SharedProjectContentRecord.Type;

export class SharedProjectContentStore extends Context.Service<
  SharedProjectContentStore,
  {
    readonly read: (
      projectId: string,
      rootId: string,
    ) => Effect.Effect<
      {
        readonly generation: number;
        readonly record: SharedProjectContentRecord;
      } | null,
      SharedProjectContentError
    >;
    readonly save: (
      projectId: string,
      rootId: string,
      generation: number,
      record: SharedProjectContentRecord,
    ) => Effect.Effect<number, SharedProjectContentError>;
    readonly putChunk: (contents: string) => Effect.Effect<string, SharedProjectContentError>;
    readonly readChunk: (digest: string) => Effect.Effect<string, SharedProjectContentError>;
    readonly validateRetained: (
      retained: typeof RetainedProjectContent.Type,
    ) => Effect.Effect<void, SharedProjectContentError>;
  }
>()("t3/project/SharedProjectContentStore") {}

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(SharedProjectContentRecord));
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(SharedProjectContentRecord));
const isContentError = Schema.is(SharedProjectContentError);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const gate = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "shared-project-content", "blobs");
  const digest = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
    );
  const readBytes = Effect.fn("SharedProjectContentStore.readBytes")(function* (location: string) {
    return yield* Effect.tryPromise({
      try: async () => {
        const file = await NodeFSP.open(
          location,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > PROJECT_FOLDER_CHUNK_BYTES)
            throw new Error("Invalid content chunk");
          return await file.readFile();
        } finally {
          await file.close();
        }
      },
      catch: () => new SharedProjectContentError({ reason: "storage" }),
    });
  });
  const readChunk = Effect.fn("SharedProjectContentStore.readChunk")(function* (hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash))
      return yield* new SharedProjectContentError({ reason: "storage" });
    const bytes = yield* readBytes(path.join(root, hash));
    if ((yield* digest(bytes)) !== hash)
      return yield* new SharedProjectContentError({ reason: "storage" });
    return bytes.toString("base64");
  });
  return SharedProjectContentStore.of({
    read: Effect.fn("SharedProjectContentStore.read")(
      function* (projectId, rootId) {
        const rows = yield* sql<{
          generation: number;
          payload: string;
        }>`SELECT generation,payload FROM shared_project_content WHERE project_id=${projectId} AND root_id=${rootId}`;
        if (!rows[0]) return null;
        const record = yield* decodeRecord(rows[0].payload);
        return { generation: rows[0].generation, record };
      },
      Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
    ),
    save: Effect.fn("SharedProjectContentStore.save")((projectId, rootId, generation, record) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const payload = yield* encodeRecord(record).pipe(
              Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
            );
            const rows = yield* (
              generation === 0
                ? sql<{
                    generation: number;
                  }>`INSERT INTO shared_project_content(project_id,root_id,generation,payload) VALUES(${projectId},${rootId},1,${payload}) ON CONFLICT(project_id,root_id) DO NOTHING RETURNING generation`
                : sql<{
                    generation: number;
                  }>`UPDATE shared_project_content SET generation=generation+1,payload=${payload} WHERE project_id=${projectId} AND root_id=${rootId} AND generation=${generation} RETURNING generation`
            ).pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })));
            if (!rows[0]) return yield* new SharedProjectContentError({ reason: "stale" });
            if (record.conflict)
              yield* sql`INSERT INTO shared_project_content_conflicts(project_id,root_id,generation,payload) VALUES(${projectId},${rootId},${rows[0].generation},${payload})`.pipe(
                Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
              );
            return rows[0].generation;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isContentError(cause) ? cause : new SharedProjectContentError({ reason: "storage" }),
          ),
        ),
    ),
    putChunk: Effect.fn("SharedProjectContentStore.putChunk")((contents) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (contents.length > (PROJECT_FOLDER_CHUNK_BYTES / 3) * 4)
            return yield* new SharedProjectContentError({ reason: "transfer" });
          const bytes = Buffer.from(contents, "base64");
          if (
            !bytes.length ||
            bytes.length > PROJECT_FOLDER_CHUNK_BYTES ||
            bytes.toString("base64") !== contents
          )
            return yield* new SharedProjectContentError({ reason: "transfer" });
          const hash = yield* digest(bytes);
          const rows = yield* sql<{
            size: number;
            temporary: string;
            ready: number;
          }>`SELECT size,temporary,ready FROM shared_project_content_blobs WHERE digest=${hash}`.pipe(
            Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
          );
          const existing = rows[0];
          if (existing?.ready) {
            yield* readChunk(hash);
            return hash;
          }
          if (existing) {
            const recovered = yield* readChunk(hash).pipe(Effect.result);
            if (recovered._tag === "Success") {
              yield* sql`UPDATE shared_project_content_blobs SET ready=1 WHERE digest=${hash}`.pipe(
                Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
              );
              return hash;
            }
          }
          if (!existing) {
            const total = yield* sql<{
              size: number;
            }>`SELECT COALESCE(SUM(size),0) AS size FROM shared_project_content_blobs`.pipe(
              Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
            );
            if ((total[0]?.size ?? 0) + bytes.length > 4 * 1024 ** 3)
              return yield* new SharedProjectContentError({ reason: "quota" });
          }
          const temporary =
            existing?.temporary ??
            `${hash}.${yield* crypto.randomUUIDv4().pipe(Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })))}.pending`;
          if (
            (existing && existing.size !== bytes.length) ||
            !temporary.startsWith(`${hash}.`) ||
            !/^[a-f0-9]{64}\.[a-f0-9-]{36}\.pending$/.test(temporary)
          )
            return yield* new SharedProjectContentError({ reason: "storage" });
          yield* sql`INSERT INTO shared_project_content_blobs(digest,size,temporary,ready) VALUES(${hash},${bytes.length},${temporary},0) ON CONFLICT(digest) DO NOTHING`.pipe(
            Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
          );
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
              const disk = await NodeFSP.statfs(root);
              if (disk.bavail * disk.bsize < 512 * 1024 ** 2 + bytes.length)
                throw new SharedProjectContentError({ reason: "quota" });
              const stage = path.join(root, temporary);
              try {
                await NodeFSP.writeFile(stage, bytes, { mode: 0o600, flag: "wx", flush: true });
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
                const file = await NodeFSP.open(
                  stage,
                  NodeFS.constants.O_RDONLY |
                    NodeFS.constants.O_NOFOLLOW |
                    NodeFS.constants.O_NONBLOCK,
                );
                let complete = false;
                try {
                  const stat = await file.stat();
                  if (!stat.isFile() || stat.size > PROJECT_FOLDER_CHUNK_BYTES)
                    throw new Error("Invalid owned staging file", { cause });
                  complete =
                    NodeCrypto.createHash("sha256")
                      .update(await file.readFile())
                      .digest("hex") === hash;
                } finally {
                  await file.close();
                }
                if (!complete) {
                  // The persisted receipt owns this exact partial staging file.
                  await NodeFSP.unlink(stage);
                  await NodeFSP.writeFile(stage, bytes, { mode: 0o600, flag: "wx", flush: true });
                }
              }
            },
            catch: (cause) =>
              isContentError(cause) ? cause : new SharedProjectContentError({ reason: "storage" }),
          });
          const staged = yield* readBytes(path.join(root, temporary));
          if ((yield* digest(staged)) !== hash)
            return yield* new SharedProjectContentError({ reason: "storage" });
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.rename(path.join(root, temporary), path.join(root, hash));
              const directory = await NodeFSP.open(root, "r");
              try {
                await directory.sync();
              } finally {
                await directory.close();
              }
            },
            catch: () => new SharedProjectContentError({ reason: "storage" }),
          });
          yield* sql`UPDATE shared_project_content_blobs SET ready=1 WHERE digest=${hash}`.pipe(
            Effect.mapError(() => new SharedProjectContentError({ reason: "storage" })),
          );
          return hash;
        }),
      ),
    ),
    readChunk,
    validateRetained: Effect.fn("SharedProjectContentStore.validateRetained")(function* (retained) {
      for (const entry of retained.entries) {
        if (entry.kind !== "file") continue;
        const hashes = Object.hasOwn(retained.chunks, entry.path)
          ? retained.chunks[entry.path]!
          : [];
        if (hashes.length !== Math.ceil(entry.byteLength / PROJECT_FOLDER_CHUNK_BYTES))
          return yield* new SharedProjectContentError({ reason: "transfer" });
        const whole = NodeCrypto.createHash("sha256");
        let length = 0;
        for (const hash of hashes) {
          const bytes = Buffer.from(yield* readChunk(hash), "base64");
          length += bytes.length;
          whole.update(bytes);
        }
        if (length !== entry.byteLength || whole.digest("hex") !== entry.hash)
          return yield* new SharedProjectContentError({ reason: "transfer" });
      }
    }),
  });
});

export const layer = Layer.effect(SharedProjectContentStore, make);
