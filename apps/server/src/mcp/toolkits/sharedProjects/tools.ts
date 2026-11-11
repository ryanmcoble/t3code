import {
  SharedProjectState,
  SharedProjectCommand,
  SharedProjectManifest,
  SharedProjectBinding,
  SharedProjectError,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as SharedProjects from "../../../project/SharedProjects.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  SharedProjects.SharedProjects,
  ThreadManagement.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
];
const failure = Schema.Union([
  SharedProjectError,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
]);
export const SharedProjectToolkit = Toolkit.make(
  Tool.make("t3_shared_projects", {
    description:
      "Read shared project manifests and this environment’s local root mappings. Requires settings permission and full access. Stable root IDs are portable; mapped paths belong to this machine. Configuration is separate from content replication and execution readiness.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: SharedProjectState,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_shared_project_configure", {
    description:
      "Publish a shared project manifest on its nominated owner, bind its roots to registered local project IDs, or detach a mapping. Select members explicitly. Read current manifest and binding revisions first; stale writes are refused. These operations configure metadata; preparation and execution are separate.",
    parameters: Schema.Struct({
      environmentId: OrchestratorMcpEnvironmentTarget,
      command: SharedProjectCommand,
    }),
    success: Schema.Union([SharedProjectManifest, SharedProjectBinding, Schema.Null]),
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);
