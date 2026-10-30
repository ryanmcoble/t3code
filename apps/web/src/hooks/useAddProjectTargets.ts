import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { useEnvironments } from "../state/environments";
import { useEnvironmentsWithScope, useEnvironmentScope } from "../state/session";

export type AddProjectTarget = Pick<EnvironmentOption, "environmentId" | "label" | "machine">;

/**
 * Connected machines that do not have the project yet and can clone it.
 * `projectEnvironments` is the project's current machine list, from
 * `useLogicalProjectEnvironments`. Folders require file transfer support on both machines.
 */
export function useAddProjectTargets(
  project: EnvironmentProject | null,
  projectEnvironments: readonly Pick<EnvironmentOption, "environmentId">[] | undefined,
): readonly AddProjectTarget[] {
  const { environments } = useEnvironments();
  const canClone = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  const canWriteFiles = useEnvironmentsWithScope(environments, AuthFilesystemWriteScope);
  const canCreate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const canReadSource = useEnvironmentScope(
    project?.environmentId ?? null,
    AuthFilesystemReadScope,
  );
  const isFolder = !project?.repositoryIdentity?.locator.remoteUrl;
  const source = environments.find((env) => env.environmentId === project?.environmentId);
  if (
    !project ||
    (isFolder &&
      (!canReadSource ||
        source?.serverConfig?.environment?.capabilities?.projectFolderTransfer !== true))
  )
    return [];
  const hasProject = new Set([
    project.environmentId,
    ...(projectEnvironments ?? []).map((env) => env.environmentId),
  ]);
  return environments
    .filter(
      (environment) =>
        !hasProject.has(environment.environmentId) &&
        canCreate.has(environment.environmentId) &&
        (isFolder
          ? canWriteFiles.has(environment.environmentId) &&
            environment.serverConfig?.environment?.capabilities?.projectFolderTransfer === true
          : canClone.has(environment.environmentId)) &&
        canCreateProjectInEnvironment(environment.connection.phase) &&
        environment.serverConfig !== null,
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      machine: resolveEnvironmentMachineKind(environment.serverConfig),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}
