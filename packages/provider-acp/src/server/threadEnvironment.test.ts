import { describe, expect, it } from "vite-plus/test";

import { acpThreadEnvironment } from "./adapter.ts";

describe("acpThreadEnvironment", () => {
  it("identifies the T3 thread and agent to the agent process", () => {
    expect(acpThreadEnvironment({ threadId: "thread-1", agentName: "copilot" })).toEqual({
      T3CODE_THREAD_ID: "thread-1",
      T3CODE_PROVIDER: "copilot",
    });
  });

  it("adds nothing without a thread", () => {
    expect(acpThreadEnvironment(undefined)).toEqual({});
  });
});
