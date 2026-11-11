import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ComputerUseConfig, computerAppAllowed } from "./computerUse.ts";

describe("computer application rules", () => {
  it("keeps exact app selection narrow and permits explicit prefix or all-app rules", () => {
    expect(computerAppAllowed(["com.apple.calculator"], "com.apple.calculator")).toBe(true);
    expect(computerAppAllowed(["com.apple.calculator"], "com.apple.calculator.other")).toBe(false);
    expect(computerAppAllowed(["com.apple.*"], "com.apple.calculator", true)).toBe(true);
    expect(computerAppAllowed(["com.apple.*"], "com.applex.calculator", true)).toBe(false);
    expect(computerAppAllowed(["*"], "com.example.editor", true)).toBe(true);
    expect(computerAppAllowed(["*"], "com.example.editor")).toBe(false);
    expect(computerAppAllowed(["com.apple.*"], "com.apple.calculator")).toBe(false);
    expect(computerAppAllowed(["*"], "", true)).toBe(false);
    expect(computerAppAllowed(["com.*.editor"], "com.example.editor")).toBe(false);
  });
  it("rejects ambiguous wildcard syntax without interpreting app identifiers as regex", () => {
    const decode = Schema.decodeUnknownSync(ComputerUseConfig);
    expect(() =>
      decode({
        enabled: true,
        command: "driver",
        providerInstanceIds: [],
        allowedApps: ["com.*.editor"],
      }),
    ).toThrow();
    expect(computerAppAllowed(["com.example.editor+"], "com.example.editor")).toBe(false);
    expect(computerAppAllowed(["com.example.editor+"], "com.example.editor+")).toBe(true);
  });
});
