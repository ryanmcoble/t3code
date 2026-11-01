import type { MemoryPathRule } from "@t3tools/contracts";

type MemoryRulesDraft = {
  readonly folderRoots: string;
  readonly repositoryRoots: string;
  readonly exclusions: string;
  readonly descendants: boolean;
};
const lines = (value: string) => [
  ...new Set(
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
const within = (value: string, path: string) => {
  const root = path.replace(/[\\/]+$/, "");
  return value === root || value.startsWith(root + "/") || value.startsWith(root + "\\");
};

export function memoryRulesDraftError(draft: MemoryRulesDraft): string | null {
  const roots = [...lines(draft.folderRoots), ...lines(draft.repositoryRoots)];
  return lines(draft.exclusions).some((excluded) => !roots.some((root) => within(excluded, root)))
    ? "Each exclusion must be inside one of the selected folder or repository roots."
    : null;
}

export function memoryRulesFromDraft(draft: MemoryRulesDraft): ReadonlyArray<MemoryPathRule> {
  const exclusions = lines(draft.exclusions);
  return [
    ...lines(draft.folderRoots).map((path) => ({
      kind: "folder" as const,
      path,
      descendants: draft.descendants,
    })),
    ...lines(draft.repositoryRoots).map((path) => ({
      kind: "repository" as const,
      path,
      descendants: true,
    })),
  ].map((rule) => ({
    ...rule,
    exclusions: exclusions.filter((value) => within(value, rule.path)),
  }));
}
