import type {
  EnvironmentId,
  SharedProjectBinding,
  SharedProjectManifest,
} from "@t3tools/contracts";

export function sharedProjectMappingStatus(
  project: SharedProjectManifest,
  binding: SharedProjectBinding | undefined,
  environmentId: EnvironmentId,
): { readonly title: string; readonly detail: string } {
  if (project.archived) return { title: "Archived", detail: "Local folders are preserved." };
  if (!project.members.includes(environmentId))
    return {
      title: "Not a member",
      detail: "The owner must select this machine before mapping folders.",
    };
  if (!binding || binding.detached || binding.environmentId !== environmentId)
    return {
      title: "Choose local folders",
      detail: "Map each shared root to a registered project on this machine.",
    };
  if (binding.manifestRevision !== project.revision)
    return {
      title: "Mappings need review",
      detail: "The shared project changed. Review every root and save the mappings again.",
    };
  if (binding.paused)
    return { title: "Paused", detail: "Folder mappings are saved; preparation is paused." };
  return {
    title: "Folders mapped",
    detail:
      "Mappings are current. Content synchronization and execution readiness have not been verified.",
  };
}

export function sharedProjectMemberLabel(
  id: EnvironmentId,
  machines: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
): string {
  return machines.find((machine) => machine.environmentId === id)?.label ?? "Unavailable machine";
}
