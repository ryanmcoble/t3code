import {
  OrchestratorMcpFailure,
  SharedProjectError,
  SharedProjectContentError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";

export class LocalServerNotRunningError extends Schema.TaggedError<LocalServerNotRunningError>()(
  "LocalServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

export class LocalServerUnreachableError extends Schema.TaggedError<LocalServerUnreachableError>()(
  "LocalServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not reach the T3 Code server at ${this.origin}.${reason}`;
  }
}

export class McpToolFailedError extends Schema.TaggedError<McpToolFailedError>()(
  "McpToolFailedError",
  { tool: Schema.String, detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const isLocalMcpError = Schema.is(
  Schema.Union([LocalServerNotRunningError, LocalServerUnreachableError, McpToolFailedError]),
);
export const reportLocalMcpErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isLocalMcpError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const decodeFailureText = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([OrchestratorMcpFailure, SharedProjectError, SharedProjectContentError]),
  ),
);
const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});

const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => failure.message,
  });
};

export const makeLocalMcpTools = (session: McpToolSession, origin: string) => {
  const unexpected = (tool: string) =>
    new McpToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.mcp.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], LocalServerUnreachableError | McpToolFailedError> {
      const raw = yield* session
        .call(tool, args)
        .pipe(Effect.mapError((cause) => new LocalServerUnreachableError({ origin, cause })));
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new McpToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};
export type LocalMcpTools = ReturnType<typeof makeLocalMcpTools>;

/**
 * Signs in as a short-lived MCP client of the running server, the same way an
 * outside agent does, and revokes that session when the command ends.
 */
export const withLocalMcpTools = Effect.fn("cli.mcp.withLocalMcpTools")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (tools: LocalMcpTools) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new LocalServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: "t3 local cli",
        // The CLI runs as the machine owner; server-side scopes still authorize each tool.
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: "t3-local-cli",
    }).pipe(Effect.mapError((cause) => new LocalServerUnreachableError({ origin, cause })));
    return yield* run(makeLocalMcpTools(session, origin));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});
