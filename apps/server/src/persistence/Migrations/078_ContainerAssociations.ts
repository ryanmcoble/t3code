import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE container_associations (engine_id TEXT NOT NULL, container_id TEXT NOT NULL, folder TEXT NOT NULL, rule TEXT NOT NULL CHECK(rule IN ('include','exclude')), PRIMARY KEY(engine_id,container_id,folder))`;
});
