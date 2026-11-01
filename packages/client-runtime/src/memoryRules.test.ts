import { describe, expect, it } from "@effect/vitest";
import { memoryRulesDraftError, memoryRulesFromDraft } from "./memoryRules.ts";

describe("memory category drafts", () => {
  const draft = {
    folderRoots: "/home/ryan/company\n/home/ryan/company\n",
    repositoryRoots: "/home/ryan/crypto/app",
    exclusions: "/home/ryan/company/private\n/home/ryan/crypto/app/scratch",
    descendants: true,
  };
  it("deduplicates roots and assigns each exclusion to its own location", () => {
    expect(memoryRulesDraftError(draft)).toBeNull();
    expect(memoryRulesFromDraft(draft)).toEqual([
      {
        kind: "folder",
        path: "/home/ryan/company",
        descendants: true,
        exclusions: ["/home/ryan/company/private"],
      },
      {
        kind: "repository",
        path: "/home/ryan/crypto/app",
        descendants: true,
        exclusions: ["/home/ryan/crypto/app/scratch"],
      },
    ]);
  });
  it("rejects unmatched exclusions rather than silently widening a category", () => {
    expect(
      memoryRulesDraftError({ ...draft, exclusions: "/home/ryan/company-other" }),
    ).not.toBeNull();
    expect(
      memoryRulesDraftError({ ...draft, folderRoots: "", repositoryRoots: "" }),
    ).not.toBeNull();
  });
});
