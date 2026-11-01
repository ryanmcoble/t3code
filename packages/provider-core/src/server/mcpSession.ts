import * as Schema from "effect/Schema";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface ResolvedSetupConnection {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args: ReadonlyArray<string>;
  readonly url?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface McpProviderSessionConfig {
  readonly setupConnections?: ReadonlyArray<ResolvedSetupConnection>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

export function setupClaudeMcpServers(config: McpProviderSessionConfig) {
  return Object.fromEntries(
    (config.setupConnections ?? []).map((c) => [
      c.name,
      c.transport === "http"
        ? { type: "http" as const, url: c.url!, headers: { ...c.headers } }
        : {
            type: "stdio" as const,
            command: c.command!,
            args: [...c.args],
            env: { ...c.environment },
          },
    ]),
  );
}

const quoteMcpName = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export function setupCodexMcpConfig(config: McpProviderSessionConfig) {
  return Object.fromEntries(
    (config.setupConnections ?? []).map((c) => [
      `mcp_servers.${c.name.includes(".") ? quoteMcpName(c.name) : c.name}`,
      c.transport === "http"
        ? { url: c.url!, http_headers: { ...c.headers } }
        : { command: c.command!, args: [...c.args], env: { ...c.environment } },
    ]),
  );
}

export function setupAcpMcpServers(config: McpProviderSessionConfig) {
  return (config.setupConnections ?? []).map((c) =>
    c.transport === "http"
      ? {
          type: "http" as const,
          name: c.name,
          url: c.url!,
          headers: Object.entries(c.headers).map(([name, value]) => ({ name, value })),
        }
      : {
          name: c.name,
          command: c.command!,
          args: [...c.args],
          env: Object.entries(c.environment).map(([name, value]) => ({ name, value })),
        },
  );
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
