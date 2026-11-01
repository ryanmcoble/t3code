import { SetupProfileError, type SetupProfile } from "@t3tools/contracts";

export const MAX_SETUP_PACKAGE_BYTES = 64 * 1024 * 1024;
// Complete toolkits can contain several bounded binaries plus their supporting files.
export const MAX_SETUP_PROFILE_BYTES = 512 * 1024 * 1024;
export const MAX_SETUP_FILES = 10_000;

export function validSetupName(name: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}

export function validSetupPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          !/[\\:\x00-\x1f<>"|?*]|[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

export function hasInlineCredential(args: ReadonlyArray<string>): boolean {
  return args.some(
    (arg) =>
      /^--(?:api[-_]key|access[-_]token|refresh[-_]token|token|password|secret|authorization)(?:=|$)/i.test(
        arg,
      ) ||
      /:\/\/[^/\s]*:[^/\s]*@/.test(arg) ||
      /[?&](?:api_key|access_token|token|password|secret)=/i.test(arg),
  );
}

export function validateSetupProfile(profile: Pick<SetupProfile, "connections" | "skills">): void {
  const names = new Set<string>();
  if (profile.connections.length > 128 || profile.skills.length > 512)
    throw new SetupProfileError({ reason: "invalid" });
  for (const c of profile.connections) {
    if (
      !validSetupName(c.name) ||
      c.name.startsWith("t3-code") ||
      names.has(c.name.toLowerCase()) ||
      hasInlineCredential(c.args) ||
      c.args.length > 128 ||
      c.args.some((s) => s.length > 16384)
    )
      throw new SetupProfileError({ reason: "invalid" });
    names.add(c.name.toLowerCase());
    for (const values of [c.environment, c.headers]) {
      if (
        Object.keys(values).length > 128 ||
        Object.entries(values).some(
          ([key, value]) =>
            key.length > 1024 ||
            /[\x00-\x1f]/.test(key) ||
            (value.kind === "literal" && value.value.length > 65536),
        )
      ) {
        throw new SetupProfileError({ reason: "invalid" });
      }
    }
    if (c.transport === "stdio" && !c.command?.trim())
      throw new SetupProfileError({ reason: "invalid" });
    if (c.transport === "http") {
      const url = new URL(c.url ?? "");
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new SetupProfileError({ reason: "invalid" });
      }
    }
  }
  names.clear();
  let total = 0;
  for (const skill of profile.skills) {
    if (
      !validSetupName(skill.name) ||
      names.has(skill.name.toLowerCase()) ||
      !skill.files.some((f) => f.path === "SKILL.md")
    ) {
      throw new SetupProfileError({ reason: "invalid" });
    }
    names.add(skill.name.toLowerCase());
    const paths = new Set<string>();
    if (skill.files.length > MAX_SETUP_FILES) throw new SetupProfileError({ reason: "invalid" });
    for (const f of skill.files) {
      const key = f.path.toLowerCase();
      total += f.size;
      if (
        !validSetupPath(f.path) ||
        paths.has(key) ||
        f.size > MAX_SETUP_PACKAGE_BYTES ||
        total > MAX_SETUP_PROFILE_BYTES
      )
        throw new SetupProfileError({ reason: "invalid" });
      paths.add(key);
    }
    for (const key of paths) {
      const parts = key.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        if (paths.has(parts.slice(0, depth).join("/")))
          throw new SetupProfileError({ reason: "invalid" });
      }
    }
  }
}
