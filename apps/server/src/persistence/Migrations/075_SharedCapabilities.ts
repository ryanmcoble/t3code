import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_scopes (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE memory_entries (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE, payload TEXT NOT NULL, active INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX memory_entries_scope ON memory_entries(scope_id, active)`;
  yield* sql`CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED, scope_id UNINDEXED, title, content)`;
  yield* sql`CREATE TABLE memory_bindings (scope_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE memory_grants (token_hash TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE, destination_id TEXT NOT NULL, access TEXT NOT NULL)`;
  yield* sql`CREATE TABLE computer_use_state (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL, lease TEXT)`;
});
