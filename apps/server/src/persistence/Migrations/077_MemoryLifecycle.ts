import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE memory_receipts (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE INDEX memory_receipts_thread ON memory_receipts(thread_id)`;
  yield* sql`CREATE TABLE memory_suggestions (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL)`;
  yield* sql`CREATE TABLE memory_context_entries (thread_id TEXT NOT NULL, context_key TEXT NOT NULL, entry_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(thread_id,context_key,entry_id))`;
  yield* sql`CREATE TABLE memory_thread_policies (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE memory_capture_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, day TEXT NOT NULL, reserved_tokens INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX memory_capture_jobs_pending ON memory_capture_jobs(status)`;
});
