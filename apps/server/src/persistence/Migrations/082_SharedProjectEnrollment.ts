import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_project_grants (project_id TEXT NOT NULL, destination_id TEXT NOT NULL, token_hash TEXT NOT NULL, PRIMARY KEY(project_id,destination_id))`;
  yield* sql`CREATE TABLE shared_project_subscriptions (project_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
});
