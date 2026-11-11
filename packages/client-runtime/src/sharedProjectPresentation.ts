import type {
  EnvironmentId,
  SharedProjectBinding,
  SharedProjectManifest,
  SharedProjectSubscription,
  SharedProjectContentReceipt,
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
      "Folder mappings are current. Review content preparation separately; execution requirements have not been verified.",
  };
}

export function sharedProjectFileStatus(input: {
  readonly project: SharedProjectManifest;
  readonly binding: SharedProjectBinding | undefined;
  readonly subscription: SharedProjectSubscription;
  readonly receipt: typeof SharedProjectContentReceipt.Type | undefined;
  readonly environmentId: EnvironmentId;
}): { readonly title: string; readonly detail: string } {
  const mapping = sharedProjectMappingStatus(input.project, input.binding, input.environmentId);
  if (mapping.title !== "Folders mapped") return mapping;
  if (!input.subscription.receiveFiles)
    return {
      title: "File receiving off",
      detail: "Saved files and recovery versions remain local.",
    };
  if (input.subscription.paused)
    return {
      title: "Owner connection paused",
      detail: "Resume the owner connection to receive new snapshots.",
    };
  if (input.subscription.error)
    return { title: "Owner connection needs attention", detail: input.subscription.error };
  const receipt = input.receipt;
  if (!receipt)
    return {
      title: "Waiting for first check",
      detail: "The server will prepare this folder without keeping Settings open.",
    };
  if (
    receipt.manifestRevision !== input.project.revision ||
    receipt.bindingRevision !== input.binding?.revision
  )
    return {
      title: "Preparation needs refresh",
      detail: "The saved receipt belongs to an older mapping or project definition.",
    };
  switch (receipt.phase) {
    case "current":
      return {
        title: "Saved snapshot applied",
        detail: "The last received snapshot is applied. Execution readiness is checked separately.",
      };
    case "local-changes":
      return {
        title: "Local edits kept",
        detail: "Local changes remain in this folder and have not been published to the owner.",
      };
    case "conflict":
      return {
        title: `${receipt.conflictCount} ${receipt.conflictCount === 1 ? "conflict" : "conflicts"} to review`,
        detail: "Both versions are preserved. Review before choosing which saved version to keep.",
      };
    case "waiting":
      return {
        title: "Preparation waiting",
        detail: receipt.error ?? "Waiting for active work to finish.",
      };
    case "error":
      return {
        title: "Preparation needs attention",
        detail:
          receipt.error ??
          "Refresh preparation after checking this machine and its owner connection.",
      };
  }
}

export function sharedProjectMemberLabel(
  id: EnvironmentId,
  machines: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
): string {
  return machines.find((machine) => machine.environmentId === id)?.label ?? "Unavailable machine";
}
