import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_project_revisions (project_id TEXT NOT NULL, revision INTEGER NOT NULL, owner_environment_id TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_id,revision))`;
  yield* sql`CREATE TABLE shared_project_bindings (project_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, binding_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;
});
