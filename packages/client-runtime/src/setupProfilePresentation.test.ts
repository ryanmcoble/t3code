import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, type SetupProfileBinding } from "@t3tools/contracts";
import { setupProfilePresentation } from "./setupProfilePresentation.ts";

const binding = (changes: Partial<SetupProfileBinding> = {}): SetupProfileBinding => ({
  profile: {
    id: "shared",
    name: "Shared setup",
    ownerEnvironmentId: EnvironmentId.make("owner"),
    revision: 9,
    schemaVersion: 1,
    connections: [],
    skills: [],
  },
  sourceUrl: null,
  instanceIds: [ProviderInstanceId.make("codex")],
  enabled: true,
  observedRevision: 9,
  appliedRevision: 9,
  items: [],
  error: null,
  ...changes,
});
const item = (status: SetupProfileBinding["items"][number]["status"]) => ({
  name: "tool",
  kind: "mcp" as const,
  instanceId: ProviderInstanceId.make("codex"),
  status,
  message: "",
});

describe("setupProfilePresentation", () => {
  it("keeps blocked activation visible even when the revision was previously applied", () => {
    const state = setupProfilePresentation(
      binding({ error: "Waiting for active work to finish before activating setup." }),
    );
    expect(state.state).toBe("waiting");
    expect(state.canRetry).toBe(false);
    expect(
      setupProfilePresentation(
        binding({
          conflicts: ["skill.md"],
          error: "Waiting for active work to finish before activating setup.",
        }),
      ).state,
    ).toBe("conflicts");
  });
  it("does not treat configured tools, paused subscriptions or empty profiles as verified", () => {
    expect(setupProfilePresentation(binding({ items: [item("configured")] })).state).toBe(
      "configured",
    );
    expect(setupProfilePresentation(binding({ items: [item("verified")] })).state).toBe("verified");
    expect(
      setupProfilePresentation(binding({ enabled: false, items: [item("verified")] })).state,
    ).toBe("paused");
    expect(setupProfilePresentation(binding()).state).toBe("configured");
    expect(setupProfilePresentation(null).state).toBe("empty");
  });
  it("offers retry for failures and guides missing credentials before retry", () => {
    expect(setupProfilePresentation(binding({ items: [item("needs-secret")] })).canRetry).toBe(
      false,
    );
    expect(setupProfilePresentation(binding({ items: [item("failed")] })).canRetry).toBe(true);
    expect(setupProfilePresentation(binding({ observedRevision: 10 })).state).toBe("pending");
    expect(setupProfilePresentation(binding({ detached: true, error: "old failure" })).state).toBe(
      "detached",
    );
  });
});
