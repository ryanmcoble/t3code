import {
  AuthSettingsWriteScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type AuthEnvironmentScope,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SharedProjects from "../../../project/SharedProjects.ts";
import * as SharedProjectEnrollment from "../../../project/SharedProjectEnrollment.ts";
import * as SharedProjectContentReplica from "../../../project/SharedProjectContentReplica.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, assertFullAccess } from "../../threadAccess.ts";
import { SharedProjectToolkit } from "./tools.ts";

const authorized = Effect.gen(function* () {
  const caller = yield* readCaller();
  yield* assertFullAccess(caller, "Shared project configuration requires full access.");
  if (caller.scope.client && !caller.scope.client.scopes?.includes(AuthSettingsWriteScope))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This MCP connection needs settings:write permission for shared project configuration.",
    });
  return yield* SharedProjects.SharedProjects;
});
const filesystemAccess = Effect.fn("mcp.sharedProjects.filesystemAccess")(function* (
  scope: AuthEnvironmentScope,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (invocation.client && !invocation.client.scopes?.includes(scope))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `This MCP connection needs ${scope} permission for shared project files.`,
    });
});
export const layer = McpToolAccess.toLayer(SharedProjectToolkit, {
  t3_shared_project_files: McpToolAccess.reads((payload) =>
    Effect.gen(function* () {
      yield* authorized;
      const service = yield* SharedProjectContentReplica.SharedProjectContentReplica;
      if (payload.query.operation === "state")
        return yield* service.state(payload.query.sharedProjectId);
      yield* filesystemAccess(AuthFilesystemReadScope);
      return yield* service.conflictPage(payload.query);
    }),
  ),
  t3_shared_project_files_prepare: McpToolAccess.writesWithCapability((payload) =>
    Effect.gen(function* () {
      yield* authorized;
      yield* filesystemAccess(AuthFilesystemWriteScope);
      const service = yield* SharedProjectContentReplica.SharedProjectContentReplica;
      yield* service.command(payload.command);
      return yield* service.state(payload.command.sharedProjectId);
    }),
  ),
  t3_shared_projects: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const service = yield* authorized;
      const enrollment = yield* SharedProjectEnrollment.SharedProjectEnrollment;
      return { ...(yield* service.state), enrollment: yield* enrollment.state };
    }),
  ),
  t3_shared_project_configure: McpToolAccess.writesWithCapability((payload) =>
    Effect.gen(function* () {
      const service = yield* authorized;
      const command = payload.command;
      switch (command.operation) {
        case "publish":
          return yield* service.publish(command.manifest);
        case "bind":
          return yield* service.bind(command.binding);
        case "unbind":
          yield* service.unbind(command.sharedProjectId, command.expectedBindingRevision);
          return null;
      }
    }),
  ),
  t3_shared_project_subscription: McpToolAccess.writesWithCapability((payload) =>
    Effect.gen(function* () {
      yield* authorized;
      const service = yield* SharedProjectEnrollment.SharedProjectEnrollment;
      yield* service.command(payload.command);
      return yield* service.state;
    }),
  ),
});
