import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE execution_workspaces (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, root TEXT NOT NULL, created_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE execution_containers (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES execution_workspaces(id), request_id TEXT NOT NULL, engine_id TEXT NOT NULL, container_id TEXT, name TEXT NOT NULL UNIQUE, specification_json TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pending','ready','releasing','failed','released')), generation INTEGER NOT NULL DEFAULT 1, retained INTEGER NOT NULL DEFAULT 0, failure TEXT, updated_at INTEGER NOT NULL, UNIQUE(workspace_id,request_id))`;
  yield* sql`CREATE TABLE execution_container_references (resource_id TEXT NOT NULL REFERENCES execution_containers(id), thread_id TEXT NOT NULL, PRIMARY KEY(resource_id,thread_id))`;
});
