import {
  SharedProjectState,
  SharedProjectEnrollmentState,
  SharedProjectSubscriptionControl,
  SharedProjectCommand,
  SharedProjectManifest,
  SharedProjectBinding,
  SharedProjectError,
  SharedProjectContentError,
  SharedProjectContentState,
  SharedProjectContentStateInput,
  SharedProjectContentConflictInput,
  SharedProjectContentConflictPage,
  SharedProjectContentCommand,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as SharedProjects from "../../../project/SharedProjects.ts";
import * as SharedProjectEnrollment from "../../../project/SharedProjectEnrollment.ts";
import * as SharedProjectContentReplica from "../../../project/SharedProjectContentReplica.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  SharedProjects.SharedProjects,
  SharedProjectEnrollment.SharedProjectEnrollment,
  SharedProjectContentReplica.SharedProjectContentReplica,
  ThreadManagement.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
];
const failure = Schema.Union([
  SharedProjectError,
  SharedProjectContentError,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
]);
export const SharedProjectToolkit = Toolkit.make(
  Tool.make("t3_shared_project_files", {
    description:
      "Read received file-folder status or paged conflict paths. A saved snapshot is not execution readiness. Local edits are not published. Requires full access and settings:write; conflict paths also require filesystem:read.",
    parameters: Schema.Struct({
      environmentId: OrchestratorMcpEnvironmentTarget,
      query: Schema.Union([
        Schema.Struct({
          operation: Schema.Literal("state"),
          ...SharedProjectContentStateInput.fields,
        }),
        Schema.Struct({
          operation: Schema.Literal("conflicts"),
          ...SharedProjectContentConflictInput.fields,
        }),
      ]),
    }),
    success: Schema.Union([SharedProjectContentState, SharedProjectContentConflictPage]),
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_shared_project_files_prepare", {
    description:
      "Refresh non-Git file receiving or resolve all conflicts in a folder using saved local or owner versions. Read conflict paths and generation first. Both versions remain retained; later local edits and active work block overwrites. Requires full access, settings:write and filesystem:write. Enable receiving in Settings first.",
    parameters: Schema.Struct({
      environmentId: OrchestratorMcpEnvironmentTarget,
      command: SharedProjectContentCommand,
    }),
    success: SharedProjectContentState,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
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
