import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE setup_profile_revisions (
    profile_id TEXT NOT NULL, revision INTEGER NOT NULL, manifest TEXT NOT NULL,
    PRIMARY KEY (profile_id, revision)
  )`;
  yield* sql`CREATE TABLE setup_profile_binding (
    id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE setup_profile_grants (
    token_hash TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
    destination_environment_id TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE setup_profile_paths (
    path TEXT PRIMARY KEY, root TEXT NOT NULL, profile_id TEXT NOT NULL, digest TEXT,
    pending_digest TEXT, overridden INTEGER NOT NULL DEFAULT 0
  )`;
});
