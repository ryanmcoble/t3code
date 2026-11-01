import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { copilotSetupMcpArgument } from "./copilotSetupMcp.ts";

it.layer(NodeServices.layer)("Copilot managed MCP startup config", (it) => {
  it.effect(
    "keeps credentials out of argv and removes the private config with the runtime scope",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configPath = yield* Effect.scoped(
          Effect.gen(function* () {
            const argument = yield* copilotSetupMcpArgument(
              [
                {
                  name: "profile-tool",
                  command: "node",
                  args: ["server.js"],
                  env: [{ name: "TOKEN", value: "test-secret" }],
                },
                {
                  name: "t3-code",
                  command: "t3-runtime",
                  args: ["acp-mcp-bridge"],
                  env: [{ name: "T3_ACP_MCP_AUTHORIZATION", value: "t3-test-bearer" }],
                },
              ],
              fs,
              path,
            );
            assert.isDefined(argument);
            assert.isFalse(argument!.includes("test-secret"));
            assert.isFalse(argument!.includes("t3-test-bearer"));
            const file = argument!.slice(1);
            assert.equal(Number((yield* fs.stat(file)).mode) & 0o777, 0o600);
            assert.deepEqual(JSON.parse(yield* fs.readFileString(file)), {
              mcpServers: {
                "t3-code": {
                  type: "local",
                  command: "t3-runtime",
                  args: ["acp-mcp-bridge"],
                  env: { T3_ACP_MCP_AUTHORIZATION: "t3-test-bearer" },
                  tools: ["*"],
                },
                "profile-tool": {
                  type: "local",
                  command: "node",
                  args: ["server.js"],
                  env: { TOKEN: "test-secret" },
                  tools: ["*"],
                },
              },
            });
            return file;
          }),
        );
        assert.isFalse(yield* fs.exists(configPath));
      }),
  );
  it.effect("preserves static HTTP headers without changing the user's native configuration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const argument = yield* copilotSetupMcpArgument(
        [
          {
            type: "http",
            name: "remote-tool",
            url: "https://mcp.example.test",
            headers: [{ name: "Authorization", value: "test-bearer" }],
          },
        ],
        fs,
        path,
      );
      assert.isDefined(argument);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(argument!.slice(1))), {
        mcpServers: {
          "remote-tool": {
            type: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: "test-bearer" },
            tools: ["*"],
          },
        },
      });
    }),
  );
  it.effect("adds no startup override for sessions without MCP servers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isUndefined(yield* copilotSetupMcpArgument([], fs, path));
    }),
  );
});
