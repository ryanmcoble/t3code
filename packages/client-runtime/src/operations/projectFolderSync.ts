import type { EnvironmentId, ProjectFolderEntry, ProjectFolderSyncState } from "@t3tools/contracts";
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

export function folderEntryEqual(
  a: ProjectFolderEntry | undefined,
  b: ProjectFolderEntry | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.kind === b.kind &&
    a.hash === b.hash &&
    a.byteLength === b.byteLength &&
    a.mode === b.mode &&
    a.linkTarget === b.linkTarget
  );
}

export function planFolderSync(
  baseline: ReadonlyArray<ProjectFolderEntry>,
  local: ReadonlyArray<ProjectFolderEntry>,
  remote: ReadonlyArray<ProjectFolderEntry>,
) {
  const before = new Map(baseline.map((entry) => [entry.path, entry]));
  const left = new Map(local.map((entry) => [entry.path, entry]));
  const right = new Map(remote.map((entry) => [entry.path, entry]));
  const merged: Array<{ entry: ProjectFolderEntry; source: "local" | "remote" }> = [];
  const conflicts: string[] = [];
  for (const path of new Set([...before.keys(), ...left.keys(), ...right.keys()])) {
    const a = left.get(path);
    const b = right.get(path);
    const old = before.get(path);
    if (folderEntryEqual(a, b)) {
      if (a) merged.push({ entry: a, source: "local" });
    } else if (folderEntryEqual(a, old)) {
      if (b) merged.push({ entry: b, source: "remote" });
    } else if (folderEntryEqual(b, old)) {
      if (a) merged.push({ entry: a, source: "local" });
    } else conflicts.push(path);
  }
  const result = new Map(merged.map(({ entry }) => [entry.path.toLowerCase(), entry]));
  const counts = new Map<string, number>();
  for (const { entry } of merged)
    counts.set(entry.path.toLowerCase(), (counts.get(entry.path.toLowerCase()) ?? 0) + 1);
  for (const { entry } of merged) {
    if (counts.get(entry.path.toLowerCase())! > 1) conflicts.push(entry.path);
    for (
      let parent = entry.path.split("/").slice(0, -1).join("/");
      parent;
      parent = parent.split("/").slice(0, -1).join("/")
    ) {
      if (result.get(parent.toLowerCase())?.kind !== "directory") conflicts.push(parent);
    }
  }
  return { merged, conflicts: [...new Set(conflicts)].sort() };
}
