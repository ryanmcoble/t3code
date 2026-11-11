import type { ProjectFolderContentPolicy } from "@t3tools/contracts";

const localDirectories = new Set([
  ".git",
  ".t3",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".docker",
  ".kube",
  ".config",
  ".codex",
  ".claude",
  ".opencode",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vite",
  ".expo",
  "deriveddata",
]);
export function compileProjectContentPolicy(
  policy: ProjectFolderContentPolicy,
): ((relativePath: string) => boolean) | null {
  if (
    !policy.excludePaths.every(
      (value) =>
        value.length > 0 &&
        value
          .split("/")
          .every(
            (part) =>
              part !== "" &&
              part !== "." &&
              part !== ".." &&
              !/[\\:\x00-\x1f<>"|?*\[\]]|[. ]$/.test(part),
          ),
    )
  )
    return null;
  const exclusions = policy.excludePaths.map((value) => value.toLowerCase());
  return (relativePath) => {
    const parts = relativePath.toLowerCase().split("/");
    if (
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\\:\x00-\x1f]/.test(part) ||
          localDirectories.has(part),
      )
    )
      return false;
    const name = parts.at(-1)!;
    if (
      name === ".ds_store" ||
      /^\.env(?:\.|$)/.test(name) ||
      /\.(?:key|pem|p8|p12|pfx|mobileprovision|keychain|keychain-db)$/.test(name) ||
      [
        ".envrc",
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        "credentials",
        "credentials.json",
        "auth.json",
        "id_rsa",
        "id_ed25519",
      ].includes(name)
    )
      return false;
    const folded = parts.join("/");
    return !exclusions.some((value) => folded === value || folded.startsWith(`${value}/`));
  };
}
