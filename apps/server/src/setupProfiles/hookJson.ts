import * as Schema from "effect/Schema";

export type HookJsonFormat = "claude-hooks" | "copilot-hooks";
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const codec = Schema.fromJsonString(Schema.Unknown);
export const decodeHookJson = Schema.decodeUnknownSync(codec);
export const encodeHookJson = Schema.encodeSync(codec);
const ownedCommand =
  /(?:^|[/\\])sc(?:\.exe)?["']? work hook (?:claude|codex|copilot|opencode) (?:session-start|prompt|stop|session-end)$/;

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid native hook object");
  return value;
}

function list(value: unknown): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error("Invalid native hook list");
  return value;
}

function managed(entry: unknown, format: HookJsonFormat): boolean {
  const hook = record(entry);
  return (
    hook.type === "command" &&
    typeof hook[format === "copilot-hooks" ? "bash" : "command"] === "string" &&
    ownedCommand.test(String(hook[format === "copilot-hooks" ? "bash" : "command"]))
  );
}

export function hookFragment(value: unknown, format: HookJsonFormat): Record<string, unknown> {
  const current = record(value);
  if (format === "copilot-hooks" && current.version !== undefined && current.version !== 1)
    throw new Error("Unsupported native hook version");
  const hooks = record(current.hooks ?? {});
  const result: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const entries = list(groups).flatMap((group) => {
      if (format === "copilot-hooks") return managed(group, format) ? [group] : [];
      const source = record(group);
      const owned = list(source.hooks).filter((entry) => managed(entry, format));
      return owned.length ? [{ ...source, hooks: owned }] : [];
    });
    if (entries.length) result[event] = entries;
  }
  return { hooks: result };
}

export function mergeHookFragment(
  value: unknown,
  fragment: unknown,
  format: HookJsonFormat,
): Record<string, unknown> {
  const current = record(value);
  if (format === "copilot-hooks" && current.version !== undefined && current.version !== 1)
    throw new Error("Unsupported native hook version");
  const desired = record(hookFragment(fragment, format).hooks);
  const hooks = { ...record(current.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    const remaining = list(groups).flatMap((group) => {
      if (format === "copilot-hooks") return managed(group, format) ? [] : [group];
      const source = record(group);
      const entries = list(source.hooks).filter((entry) => !managed(entry, format));
      return entries.length ? [{ ...source, hooks: entries }] : [];
    });
    if (remaining.length) hooks[event] = remaining;
    else delete hooks[event];
  }
  for (const [event, groups] of Object.entries(desired)) {
    hooks[event] = [...list(hooks[event] ?? []), ...list(groups)];
  }
  return {
    ...current,
    ...(format === "copilot-hooks" ? { version: current.version ?? 1 } : {}),
    hooks,
  };
}

export function stableHookJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableHookJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${encodeHookJson(key)}:${stableHookJson(value[key])}`)
      .join(",")}}`;
  return encodeHookJson(value);
}
