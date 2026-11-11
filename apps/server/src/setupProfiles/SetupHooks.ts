import { SetupProfileError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import type { NativeSetupLayout } from "../provider/setupProfileAdapter.ts";
import * as SetupPackages from "./SetupPackages.ts";
import type { SetupFile } from "./SetupFiles.ts";
import { decodeHookJson, encodeHookJson, hookFragment, stableHookJson } from "./hookJson.ts";

type Harness = NonNullable<NativeSetupLayout["workHooks"]>["harness"];
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const failure = (cause: unknown) => new SetupProfileError({ reason: "unsupported", cause });

export const makeSetupHooks = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const packages = yield* SetupPackages.SetupPackages;
  const cache = new Map<string, { readonly hook: Uint8Array; readonly skill: Uint8Array }>();
  const verified = new Set<string>();
  const isolatedEnvironment = (root: string, executable: string): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(
      Object.keys(environment)
        .filter((key) => /^(T3CODE_|CODEX_|CLAUDE_|COPILOT_|OPENCODE_|SC_WORK_)/.test(key))
        .map((key) => [key, ""]),
    ),
    PATH: `${path.dirname(executable)}:${environment.PATH ?? "/usr/bin:/bin"}`,
    SC_WORK_HOME: root,
    SC_WORK_DIR: path.join(root, "events"),
    SC_WORK_STATE_DIR: path.join(root, "state"),
    SC_WORK_NO_SYNC: "1",
    SC_WORK_NO_NUDGE: "1",
    T3CODE_HOME: path.join(root, "unused-t3-home"),
  });
  const executable = Effect.gen(function* () {
    if (platform === "win32") return yield* new SetupProfileError({ reason: "unsupported" });
    const candidates = [
      path.join(home, ".local", "bin", "sc"),
      ...(environment.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((root) => path.join(root, "sc")),
    ];
    for (const candidate of candidates) {
      const stat = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isSome(stat) && stat.value.type === "File" && stat.value.mode & 0o111)
        return {
          command: candidate,
          key: `${candidate}:${stat.value.size}:${Option.getOrUndefined(stat.value.mtime)?.getTime()}:${Option.getOrUndefined(stat.value.ino)}`,
        };
    }
    return yield* new SetupProfileError({ reason: "not-found" });
  });
  const run = Effect.fn("SetupHooks.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    root: string,
    stdin?: string,
  ) {
    const result = yield* runner
      .run({
        command,
        args,
        env: isolatedEnvironment(root, command),
        cwd: root,
        timeout: "20 seconds",
        maxOutputBytes: 256 * 1024,
        ...(stdin === undefined ? {} : { stdin }),
      })
      .pipe(Effect.mapError(failure));
    if (result.code !== 0 || result.timedOut)
      return yield* new SetupProfileError({ reason: "unsupported" });
    return result.stdout;
  });
  const prepare = Effect.fn("SetupHooks.prepare")(function* (native: NativeSetupLayout) {
    if (!native.workHooks || !native.skillDirectory)
      return yield* new SetupProfileError({ reason: "unsupported" });
    const { command, key } = yield* executable;
    if (/[\r\n"'`$;&|<>()[\]{}*?!\\]/.test(command))
      return yield* new SetupProfileError({ reason: "unsupported" });
    const harness = native.workHooks.harness;
    const cacheKey = `${key}:${harness}`;
    let generated = cache.get(cacheKey);
    if (!generated) {
      generated = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hook-package-" });
          yield* run(command, ["work", "install", "--harness", harness], root);
          const configRoot = path.join(
            root,
            harness === "opencode" ? ".config/opencode" : `.${harness}`,
          );
          const relative =
            harness === "claude"
              ? "settings.json"
              : harness === "codex"
                ? "hooks.json"
                : harness === "copilot"
                  ? "hooks/singlecomm-work.json"
                  : "plugins/singlecomm-work.js";
          const hook = yield* fs
            .readFile(path.join(configRoot, relative))
            .pipe(Effect.mapError(failure));
          const skill = yield* fs
            .readFile(path.join(configRoot, "skills/singlecomm-work-ledger/SKILL.md"))
            .pipe(Effect.mapError(failure));
          if (hook.length > 128 * 1024 || skill.length > 128 * 1024)
            return yield* new SetupProfileError({ reason: "invalid" });
          return { hook, skill };
        }),
      );
      cache.set(cacheKey, generated);
    }
    const format =
      harness === "claude" || harness === "codex"
        ? ("claude-hooks" as const)
        : harness === "copilot"
          ? ("copilot-hooks" as const)
          : undefined;
    const hook = format
      ? yield* Effect.try({
          try: () => {
            const fragment = hookFragment(
              decodeHookJson(new TextDecoder().decode(generated.hook)),
              format,
            );
            const events = fragment.hooks;
            if (!isRecord(events)) throw new Error("Missing lifecycle hooks");
            const names =
              harness === "copilot"
                ? ["sessionStart", "userPromptSubmitted", "agentStop", "sessionEnd"]
                : ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];
            const suffixes = ["session-start", "prompt", "stop", "session-end"];
            for (const [index, name] of names.entries()) {
              const groups = events[name];
              if (!Array.isArray(groups) || groups.length !== 1 || !isRecord(groups[0]))
                throw new Error("Incomplete lifecycle hooks");
              const entries = format === "copilot-hooks" ? groups : groups[0].hooks;
              if (!Array.isArray(entries) || entries.length !== 1 || !isRecord(entries[0]))
                throw new Error("Invalid lifecycle hook");
              const expected = `${command.includes(" ") ? `"${command}"` : command} work hook ${harness} ${suffixes[index]}`;
              if (entries[0][format === "copilot-hooks" ? "bash" : "command"] !== expected)
                throw new Error("Unexpected lifecycle command");
            }
            return new TextEncoder().encode(stableHookJson(fragment));
          },
          catch: failure,
        })
      : generated.hook;
    const files: SetupFile[] = [
      {
        path: native.workHooks.path,
        root: path.dirname(native.workHooks.path),
        digest: yield* packages.put(hook),
        executable: false,
        ...(format ? { format } : {}),
      },
      {
        path: path.join(native.skillDirectory, "singlecomm-work-ledger/SKILL.md"),
        root: native.skillDirectory,
        digest: yield* packages.put(generated.skill),
        executable: false,
      },
    ];
    return { files, key: cacheKey, command, harness };
  });
  const verify = Effect.fn("SetupHooks.verify")(function* (input: {
    key: string;
    command: string;
    harness: Harness;
  }) {
    if (verified.has(input.key)) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hook-probe-" });
        const cwd = path.join(root, "Singlecomm");
        yield* fs.makeDirectory(cwd);
        const payload = encodeHookJson({
          session_id: "t3-profile-hook-probe",
          cwd,
          prompt: "Verify SingleComm work tracking.",
        });
        for (const event of ["session-start", "prompt", "stop", "session-end"]) {
          const stdout = yield* run(
            input.command,
            ["work", "hook", input.harness, event],
            root,
            payload,
          );
          if (event === "session-start") {
            const context = yield* Effect.try({
              try: () => {
                const value = decodeHookJson(stdout);
                if (!isRecord(value)) return null;
                const specific = value.hookSpecificOutput;
                return isRecord(specific) ? specific.additionalContext : value.additionalContext;
              },
              catch: failure,
            });
            if (
              typeof context !== "string" ||
              !context.includes("SingleComm work ledger is active")
            )
              return yield* new SetupProfileError({ reason: "unsupported" });
          } else if ((event === "stop" || event === "session-end") && stdout.trim())
            return yield* new SetupProfileError({ reason: "unsupported" });
        }
        const sessions = path.join(root, "state/sessions");
        const states = yield* fs.readDirectory(sessions).pipe(Effect.mapError(failure));
        if (states.length !== 1) return yield* new SetupProfileError({ reason: "unsupported" });
        const state = yield* fs.readFileString(path.join(sessions, states[0]!)).pipe(
          Effect.mapError(failure),
          Effect.flatMap((text) => Effect.try({ try: () => decodeHookJson(text), catch: failure })),
        );
        if (!isRecord(state) || state.prompts !== 1 || state.recorded !== true)
          return yield* new SetupProfileError({ reason: "unsupported" });
      }),
    );
    verified.add(input.key);
  });
  return { prepare, verify };
});
