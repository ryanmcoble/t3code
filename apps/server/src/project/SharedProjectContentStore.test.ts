// @effect-diagnostics-next-line nodeBuiltinImport:off -- Checks actual private file modes and recovery after interrupted persistence.
import * as NodeFSP from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Store from "./SharedProjectContentStore.ts";

const layer = Store.layer.pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-content-store-test-" }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);
const record: Store.SharedProjectContentRecord = {
  manifestRevision: 1,
  bindingRevision: 1,
  phase: "waiting",
  sourceHash: null,
  sourceObservation: null,
  localObservation: null,
  baseline: [],
  source: null,
  conflict: null,
  error: null,
};

it.effect(
  "persists revision-fenced baselines without letting delayed writers replace a new receipt",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.SharedProjectContentStore;
      assert.isNull(yield* store.read("sample", "docs"));
      assert.equal(yield* store.save("sample", "docs", 0, record), 1);
      const changed = { ...record, phase: "local-changes" as const };
      assert.equal(yield* store.save("sample", "docs", 1, changed), 2);
      for (const generation of [0, 1]) {
        const stale = yield* store.save("sample", "docs", generation, record).pipe(Effect.result);
        if (stale._tag !== "Failure") return assert.fail("Expected stale receipt rejection");
        assert.equal(stale.failure.reason, "stale");
      }
      assert.deepEqual(yield* store.read("sample", "docs"), { generation: 2, record: changed });
      assert.isNull(yield* store.read("sample", "other"));
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "keeps private hash-verified chunks, deduplicates them and recovers a renamed blob before its ready receipt",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.SharedProjectContentStore;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const bytes = Buffer.from("retained remote conflict version");
      const contents = bytes.toString("base64");
      const digest = yield* store.putChunk(contents);
      assert.equal(yield* store.readChunk(digest), contents);
      assert.equal(yield* store.putChunk(contents), digest);
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM shared_project_content_blobs`;
      assert.equal(rows[0]?.count, 1);
      const file = path.join(config.stateDir, "shared-project-content", "blobs", digest);
      const stat = yield* Effect.promise(() => NodeFSP.stat(file));
      assert.equal(stat.mode & 0o777, 0o600);
      yield* sql`UPDATE shared_project_content_blobs SET ready=0 WHERE digest=${digest}`;
      assert.equal(yield* store.putChunk(contents), digest);
      const recovered = yield* sql<{
        ready: number;
      }>`SELECT ready FROM shared_project_content_blobs WHERE digest=${digest}`;
      assert.equal(recovered[0]?.ready, 1);
      const pending = yield* sql<{
        temporary: string;
      }>`SELECT temporary FROM shared_project_content_blobs WHERE digest=${digest}`;
      const stage = path.join(
        config.stateDir,
        "shared-project-content",
        "blobs",
        pending[0]!.temporary,
      );
      yield* sql`UPDATE shared_project_content_blobs SET ready=0 WHERE digest=${digest}`;
      yield* Effect.promise(async () => {
        await NodeFSP.rename(file, stage);
        await NodeFSP.writeFile(stage, "partial");
      });
      assert.equal(yield* store.putChunk(contents), digest);
      assert.equal(yield* store.readChunk(digest), contents);
      const fileHash = yield* crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode));
      const retained = {
        entries: [
          {
            path: "README",
            kind: "file" as const,
            mode: 0o644,
            byteLength: bytes.length,
            hash: fileHash,
          },
        ],
        chunks: { README: [digest] },
      };
      yield* store.validateRetained(retained);
      assert.equal(
        (yield* store.validateRetained({ ...retained, chunks: {} }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* store.readChunk("../outside").pipe(Effect.result))._tag, "Failure");
      yield* Effect.promise(() => NodeFSP.writeFile(file, "corrupted cache"));
      assert.equal((yield* store.readChunk(digest).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* store.validateRetained(retained).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("rejects invalid chunks and stops before exceeding the private cache budget", () =>
  Effect.gen(function* () {
    const store = yield* Store.SharedProjectContentStore;
    for (const contents of ["", "not base64", "x".repeat(400_000)])
      assert.equal((yield* store.putChunk(contents).pipe(Effect.result))._tag, "Failure");
    const sql = yield* SqlClient.SqlClient;
    const full = "f".repeat(64);
    yield* sql`INSERT INTO shared_project_content_blobs(digest,size,temporary,ready) VALUES(${full},${4 * 1024 ** 3},'test-only-budget-reservation',0)`;
    const quota = yield* store
      .putChunk(Buffer.from("another chunk").toString("base64"))
      .pipe(Effect.result);
    if (quota._tag !== "Failure") return assert.fail("Expected cache quota to block new content");
    assert.equal(quota.failure.reason, "quota");
  }).pipe(Effect.provide(layer), Effect.scoped),
);
