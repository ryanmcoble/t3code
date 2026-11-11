import {
  SharedProjectState,
  SharedProjectEnrollmentState,
  SharedProjectSubscriptionControl,
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
import * as SharedProjectEnrollment from "../../../project/SharedProjectEnrollment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  SharedProjects.SharedProjects,
  SharedProjectEnrollment.SharedProjectEnrollment,
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
      "Read shared project manifests, local root mappings and owner-subscription health. Requires settings permission and full access. Configuration is separate from content replication and execution readiness.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: Schema.Struct({
      ...SharedProjectState.fields,
      enrollment: SharedProjectEnrollmentState,
    }),
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
  Tool.make("t3_shared_project_subscription", {
    description:
      "Pause, resume, refresh or disconnect an existing project-owner subscription. Disconnect preserves cached history and local files, and detaches mappings. Enroll new machines through Settings; credentials stay in the server secret store.",
    parameters: Schema.Struct({
      environmentId: OrchestratorMcpEnvironmentTarget,
      command: SharedProjectSubscriptionControl,
    }),
    success: SharedProjectEnrollmentState,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);
