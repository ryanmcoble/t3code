import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  setupClaudeMcpServers,
  setupCodexMcpConfig,
  setupAcpMcpServers,
  withAgentDeviceEnvironment,
} from "./mcpSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("managed native MCP configuration", () => {
  it("preserves literal names and transport credentials across native protocols", () => {
    const config = {
      environmentId: EnvironmentId.make("test"),
      threadId: ThreadId.make("test"),
      providerInstanceId: ProviderInstanceId.make("test"),
      providerSessionId: "session",
      endpoint: "https://t3.test/mcp",
      authorizationHeader: "Bearer internal",
      browserToolsAvailable: false,
      setupConnections: [
        {
          name: "catalog.v1",
          transport: "stdio" as const,
          command: "catalog",
          args: ["--mcp"],
          environment: { TOKEN: "local" },
          headers: {},
        },
        {
          name: "remote",
          transport: "http" as const,
          url: "https://tools.test/mcp",
          args: [],
          environment: {},
          headers: { Authorization: "Bearer external" },
        },
      ],
    };
    expect(setupClaudeMcpServers(config)).toEqual({
      "catalog.v1": { type: "stdio", command: "catalog", args: ["--mcp"], env: { TOKEN: "local" } },
      remote: {
        type: "http",
        url: "https://tools.test/mcp",
        headers: { Authorization: "Bearer external" },
      },
    });
    expect(setupCodexMcpConfig(config)).toEqual({
      'mcp_servers."catalog.v1"': { command: "catalog", args: ["--mcp"], env: { TOKEN: "local" } },
      "mcp_servers.remote": {
        url: "https://tools.test/mcp",
        http_headers: { Authorization: "Bearer external" },
      },
    });
    expect(setupAcpMcpServers(config)).toEqual([
      {
        name: "catalog.v1",
        command: "catalog",
        args: ["--mcp"],
        env: [{ name: "TOKEN", value: "local" }],
      },
      {
        type: "http",
        name: "remote",
        url: "https://tools.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer external" }],
      },
    ]);
    expect(config.authorizationHeader).toBe("Bearer internal");
  });
});
