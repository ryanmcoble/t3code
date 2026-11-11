import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A stack link and a per-container exception must coexist for the same folder.
  yield* sql`ALTER TABLE container_associations RENAME TO container_associations_legacy`;
  yield* sql`CREATE TABLE container_associations (engine_id TEXT NOT NULL, target_key TEXT NOT NULL, label TEXT NOT NULL, container_id TEXT NOT NULL, folder TEXT NOT NULL, rule TEXT NOT NULL CHECK(rule IN ('include','exclude')), stack_key TEXT, PRIMARY KEY(engine_id,target_key,folder))`;
  yield* sql`INSERT INTO container_associations(engine_id,target_key,label,container_id,folder,rule,stack_key) SELECT engine_id,'container:' || container_id,substr(container_id,1,12),container_id,folder,rule,NULL FROM container_associations_legacy`;
});
