import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE shared_project_grants ADD COLUMN access TEXT NOT NULL DEFAULT 'metadata' CHECK(access IN ('metadata','files','repository-history'))`;
});
