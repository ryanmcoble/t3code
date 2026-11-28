import { describe, expect, it } from "vite-plus/test";
import { compileProjectContentPolicy } from "./projectContentPolicy.ts";

const policy = { mode: "project-content" as const, excludePaths: ["local-notes"] };
describe("project content selection", () => {
  it("keeps source and portable project declarations while excluding native state, credentials and generated trees", () => {
    const include = compileProjectContentPolicy(policy)!;
    for (const path of [
      "src/index.ts",
      "README.md",
      "pnpm-lock.yaml",
      "t3.json",
      ".agents/skills/review/SKILL.md",
    ])
      expect(include(path), path).toBe(true);
    for (const path of [
      ".git/config",
      "packages/api/node_modules/a",
      "web/.next/build",
      "native/target/release/app",
      ".env",
      "nested/.env.production",
      ".npmrc",
      ".codex/auth.json",
      ".docker/config.json",
      ".ssh/id_ed25519",
      "certs/signing.p12",
      "local-notes/private.txt",
      "../escape",
      "src/../.env",
    ])
      expect(include(path), path).toBe(false);
    expect(include("local-notes-public/README.md")).toBe(true);
  });
  it("rejects ambiguous and escaping exclusion rules instead of widening content", () => {
    for (const value of [
      "",
      "..",
      "/absolute",
      "a//b",
      "a/../b",
      "C:\\private",
      "a\0b",
      "out/**",
      "[secret]",
      "temp?",
    ])
      expect(compileProjectContentPolicy({ ...policy, excludePaths: [value] })).toBeNull();
  });
});
