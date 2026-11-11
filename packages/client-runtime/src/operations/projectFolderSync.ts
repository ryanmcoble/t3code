import type { EnvironmentId, ProjectFolderSyncState } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "../state/projects.ts";

export function findFolderSyncProject<
  T extends { readonly environmentId: EnvironmentId; readonly workspaceRoot: string },
>(projects: readonly T[], state: ProjectFolderSyncState | null | undefined): T | undefined {
  if (!state) return undefined;
  return projects.find(
    (project) =>
      project.environmentId === state.peerEnvironmentId &&
      normalizeProjectPathForComparison(project.workspaceRoot) ===
        normalizeProjectPathForComparison(state.peerPath),
  );
}

export { folderEntryEqual, planFolderSync } from "@t3tools/shared/projectFolderMerge";
