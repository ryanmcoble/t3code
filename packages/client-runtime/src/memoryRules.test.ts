import { describe, expect, it } from "@effect/vitest";
import { memoryRulesDraftError, memoryRulesFromDraft } from "./memoryRules.ts";

describe("memory category drafts", () => {
  const draft = {
    folderRoots: "/home/user/company\n/home/user/company\n",
    repositoryRoots: "/home/user/project/app",
    exclusions: "/home/user/company/private\n/home/user/project/app/scratch",
    descendants: true,
  };
  it("deduplicates roots and assigns each exclusion to its own location", () => {
    expect(memoryRulesDraftError(draft)).toBeNull();
    expect(memoryRulesFromDraft(draft)).toEqual([
      {
        kind: "folder",
        path: "/home/user/company",
        descendants: true,
        exclusions: ["/home/user/company/private"],
      },
      {
        kind: "repository",
        path: "/home/user/project/app",
        descendants: true,
        exclusions: ["/home/user/project/app/scratch"],
      },
    ]);
  });
  it("rejects unmatched exclusions rather than silently widening a category", () => {
    expect(
      memoryRulesDraftError({ ...draft, exclusions: "/home/user/company-other" }),
    ).not.toBeNull();
    expect(
      memoryRulesDraftError({ ...draft, folderRoots: "", repositoryRoots: "" }),
    ).not.toBeNull();
  });
});
