import type { SetupProfileBinding } from "@t3tools/contracts";

export interface SetupProfilePresentation {
  readonly state:
    | "empty"
    | "detached"
    | "conflicts"
    | "blocked"
    | "waiting"
    | "failed"
    | "paused"
    | "pending"
    | "configured"
    | "verified";
  readonly title: string;
  readonly description: string;
  readonly canRetry: boolean;
  readonly configured: number;
  readonly verified: number;
  readonly needsAttention: number;
}

export function setupProfilePresentation(
  binding: SetupProfileBinding | null,
): SetupProfilePresentation {
  const configured = binding?.items.filter((item) => item.status === "configured").length ?? 0;
  const verified = binding?.items.filter((item) => item.status === "verified").length ?? 0;
  const needsAttention =
    binding?.items.filter((item) =>
      ["conflict", "needs-secret", "missing-prerequisite", "unsupported", "failed"].includes(
        item.status,
      ),
    ).length ?? 0;
  const counts = { configured, verified, needsAttention };
  const result = (
    state: SetupProfilePresentation["state"],
    title: string,
    description: string,
    canRetry = false,
  ): SetupProfilePresentation => ({ state, title, description, canRetry, ...counts });
  if (!binding)
    return result(
      "empty",
      "Choose a shared setup",
      "Apply a profile to share MCP connections and skills with this environment.",
    );
  if (binding.detached)
    return result(
      "detached",
      "Setup kept locally",
      "This environment no longer receives profile changes.",
    );
  if (
    (binding.conflicts?.length ?? 0) > 0 ||
    binding.items.some((item) => item.status === "conflict")
  )
    return result(
      "conflicts",
      "Local changes need review",
      "Choose which local changes to keep before this setup can activate.",
    );
  if (binding.items.some((item) => item.status === "needs-secret"))
    return result(
      "blocked",
      "A credential is needed",
      "Bind the missing credential on this environment; account sign-ins stay local.",
    );
  if (
    binding.items.some(
      (item) => item.status === "missing-prerequisite" || item.status === "unsupported",
    )
  )
    return result(
      "blocked",
      "Some tools need attention",
      "Review the affected items for missing tools or unsupported harnesses.",
      true,
    );
  // Older servers report deferred activation as a message rather than a structured phase.
  if (
    binding.error?.startsWith("Waiting for ") &&
    binding.error.includes("before activating setup")
  )
    return result(
      "waiting",
      "Waiting for idle",
      "Existing work keeps its current setup. Activation resumes automatically when it finishes.",
    );
  if (binding.error || binding.items.some((item) => item.status === "failed"))
    return result(
      "failed",
      "Setup could not finish",
      binding.error ?? "Review failed items, fix the cause, then retry.",
      true,
    );
  if (!binding.enabled)
    return result(
      "paused",
      "Automatic sync paused",
      "The applied setup is retained. Resume sync to receive future profile changes.",
    );
  if (
    binding.appliedRevision < binding.observedRevision ||
    binding.items.some((item) => item.status === "waiting")
  )
    return result(
      "pending",
      "Setup changes pending",
      "This environment has not activated all of the latest profile changes.",
    );
  if (binding.items.length > 0 && verified === binding.items.length)
    return result(
      "verified",
      "Setup verified",
      "Every reported setup item passed its verification check.",
    );
  return result(
    "configured",
    "Setup configured",
    "Configuration is applied. Each harness still needs a successful tool invocation to verify it.",
  );
}
