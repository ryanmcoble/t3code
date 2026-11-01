import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as AcpSchema from "effect-acp/compat";
import * as Schema from "effect/Schema";

const NameValue = Schema.Struct({ name: Schema.String, value: Schema.String });
const HttpServer = Schema.Struct({
  type: Schema.Literal("http"),
  name: Schema.String,
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Array(NameValue)),
});
const StdioServer = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.optionalKey(Schema.Array(NameValue)),
});
const isHttpServer = Schema.is(HttpServer);
const isStdioServer = Schema.is(StdioServer);
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// Copilot ignores custom session/new MCP entries. Its startup override augments
// the user's native config, including T3's own bridge. A private scoped file
// keeps credentials out of argv.
export const copilotSetupMcpArgument = Effect.fn("copilotSetupMcpArgument")(function* (
  servers: ReadonlyArray<AcpSchema.McpServer>,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (isHttpServer(server)) {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        headers: Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value])),
        tools: ["*"],
      };
    } else if (isStdioServer(server)) {
      mcpServers[server.name] = {
        type: "local",
        command: server.command,
        args: server.args,
        env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
        tools: ["*"],
      };
    }
  }
  if (Object.keys(mcpServers).length === 0) return undefined;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-copilot-setup-" });
  yield* fileSystem.chmod(directory, 0o700);
  const configPath = path.join(directory, "mcp.json");
  const encoded = yield* encodeConfig({ mcpServers });
  yield* fileSystem.writeFileString(configPath, encoded, { mode: 0o600 });
  return `@${configPath}`;
});
