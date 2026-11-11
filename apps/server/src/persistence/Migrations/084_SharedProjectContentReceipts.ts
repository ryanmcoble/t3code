import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE shared_project_grants RENAME TO shared_project_grants_previous`;
  yield* sql`CREATE TABLE shared_project_grants (project_id TEXT NOT NULL,destination_id TEXT NOT NULL,token_hash TEXT NOT NULL,access TEXT NOT NULL CHECK(access IN ('metadata','files','repository-history')),PRIMARY KEY(project_id,destination_id,access))`;
  yield* sql`INSERT INTO shared_project_grants SELECT project_id,destination_id,token_hash,access FROM shared_project_grants_previous`;
  yield* sql`DROP TABLE shared_project_grants_previous`;
  yield* sql`CREATE TABLE shared_project_content (project_id TEXT NOT NULL, root_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,root_id))`;
  yield* sql`CREATE TABLE shared_project_content_blobs (digest TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size>=0), temporary TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)))`;
  yield* sql`CREATE TABLE shared_project_content_conflicts (project_id TEXT NOT NULL,root_id TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,root_id,generation))`;
});
