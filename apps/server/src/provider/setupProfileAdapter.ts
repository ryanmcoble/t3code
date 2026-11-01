import type { ServerSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";

export interface NativeSetupLayout {
  readonly driver: string;
  readonly skillDirectory: string | null;
  readonly configFiles: ReadonlyArray<string>;
  readonly mcpSupported: boolean;
}

export function nativeSetupLayout(
  instance: ServerSettings["providerInstances"][ProviderInstanceId],
  home: string,
  path: Path.Path,
  inherited: NodeJS.ProcessEnv = {},
): NativeSetupLayout {
  const configSchema = Schema.Record(Schema.String, Schema.Unknown);
  const config = Schema.is(configSchema)(instance.config) ? instance.config : {};
  const configuredHome = typeof config.homePath === "string" ? config.homePath.trim() : "";
  const resolve = (value: string) =>
    value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(value);
  const variable = (name: string) => {
    const entry = instance.environment?.find((entry) => entry.name === name);
    return entry === undefined
      ? (inherited[name]?.trim() ?? "")
      : typeof entry.value === "string"
        ? entry.value.trim()
        : null;
  };
  const rootFor = (name: string, fallback: string) => {
    const value = variable(name);
    if (value === null || (value !== "" && !path.isAbsolute(value))) return null;
    return value || fallback;
  };
  switch (instance.driver) {
    case "claudeAgent": {
      const root = configuredHome
        ? resolve(configuredHome)
        : rootFor("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
      if (root === null)
        return {
          driver: instance.driver,
          skillDirectory: null,
          configFiles: [],
          mcpSupported: true,
        };
      return {
        driver: instance.driver,
        skillDirectory: path.join(root, "skills"),
        configFiles: [
          configuredHome || variable("CLAUDE_CONFIG_DIR")
            ? path.join(root, ".claude.json")
            : path.join(home, ".claude.json"),
        ],
        mcpSupported: true,
      };
    }
    case "codex": {
      const root = configuredHome
        ? resolve(configuredHome)
        : rootFor("CODEX_HOME", path.join(home, ".codex"));
      if (root === null)
        return {
          driver: instance.driver,
          skillDirectory: null,
          configFiles: [],
          mcpSupported: true,
        };
      return {
        driver: instance.driver,
        skillDirectory: path.join(root, "skills"),
        configFiles: [],
        mcpSupported: true,
      };
    }
    case "opencode": {
      const configHome = rootFor("XDG_CONFIG_HOME", path.join(home, ".config"));
      const root =
        configHome === null
          ? null
          : rootFor("OPENCODE_CONFIG_DIR", path.join(configHome, "opencode"));
      return {
        driver: instance.driver,
        skillDirectory:
          root === null || (typeof config.serverUrl === "string" && config.serverUrl.trim())
            ? null
            : path.join(root, "skills"),
        configFiles:
          root === null
            ? []
            : [path.join(root, "opencode.json"), path.join(root, "opencode.jsonc")],
        mcpSupported: !(typeof config.serverUrl === "string" && config.serverUrl.trim()),
      };
    }
    case "acpRegistry": {
      const copilot =
        config.agentId === "github-copilot-cli" ||
        (typeof config.agentId === "string" && /(?:^|\/)copilot$/.test(config.agentId)) ||
        (config.source === "local" &&
          typeof config.commandPath === "string" &&
          /^copilot(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(config.commandPath)));
      return {
        driver: instance.driver,
        skillDirectory: copilot ? path.join(home, ".copilot", "skills") : null,
        configFiles: copilot ? [path.join(home, ".copilot", "mcp-config.json")] : [],
        mcpSupported: copilot,
      };
    }
    default:
      return {
        driver: instance.driver,
        skillDirectory: null,
        configFiles: [],
        mcpSupported: false,
      };
  }
}
