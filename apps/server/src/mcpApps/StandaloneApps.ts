import {
  StandaloneAppDefinition,
  StandaloneAppError,
  StandaloneAppOpenResult,
  McpAppCallToolResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { openStdioAppConnection } from "./StdioAppConnection.ts";

export class StandaloneApps extends Context.Service<
  StandaloneApps,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<Pick<StandaloneAppDefinition, "id" | "title" | "keywords">>,
      StandaloneAppError
    >;
    readonly save: (definition: StandaloneAppDefinition) => Effect.Effect<void, StandaloneAppError>;
    readonly remove: (id: string) => Effect.Effect<void, StandaloneAppError>;
    readonly open: (id: string) => Effect.Effect<StandaloneAppOpenResult, StandaloneAppError>;
    readonly call: (
      input: { appId: string; name: string; arguments: Record<string, unknown> },
      write: boolean,
    ) => Effect.Effect<McpAppCallToolResult, StandaloneAppError>;
  }
>()("t3/mcpApps/StandaloneApps") {}

const Registry = Schema.Array(StandaloneAppDefinition).check(Schema.isMaxLength(32));
const Resource = Schema.Struct({
  contents: Schema.Array(
    Schema.Struct({
      uri: Schema.String,
      mimeType: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
});
const Tools = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      annotations: Schema.optional(
        Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) }),
      ),
    }),
  ),
  nextCursor: Schema.optional(Schema.String),
});
const decodeRegistry = Schema.decodeEffect(Schema.fromJsonString(Registry));
const encodeRegistry = Schema.encodeEffect(Schema.fromJsonString(Registry));
const decodeResource = Schema.decodeUnknownEffect(Resource);
const decodeTools = Schema.decodeUnknownEffect(Tools);
const decodeResult = Schema.decodeUnknownEffect(McpAppCallToolResult);
const error = (cause: unknown) =>
  new StandaloneAppError({
    message: cause instanceof Error ? cause.message : "App request failed.",
  });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const pathApi = yield* Path.Path;
  const path = pathApi.join(config.stateDir, "apps.json");
  const lock = yield* Semaphore.make(1);
  const connections = new Map<string, ReturnType<typeof openStdioAppConnection>>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const connection of connections.values()) connection.close();
    }),
  );
  const read = Effect.fn("StandaloneApps.readRegistry")(function* () {
    if (!(yield* fs.exists(path))) return [];
    const info = yield* fs.stat(path);
    if (Number(info.size) > 128 * 1024)
      return yield* error(new Error("App registry is too large."));
    return yield* decodeRegistry(yield* fs.readFileString(path));
  });
  const find = Effect.fn("StandaloneApps.find")(function* (id: string) {
    const app = (yield* read()).find((entry) => entry.id === id);
    if (!app) return yield* error(new Error("App is not installed on this environment."));
    return app;
  });
  const disconnect = (id: string) => {
    connections.get(id)?.close();
    connections.delete(id);
  };
  const writeRegistry = Effect.fn("StandaloneApps.writeRegistry")(function* (
    apps: readonly StandaloneAppDefinition[],
  ) {
    const encoded = yield* encodeRegistry(apps);
    if (Buffer.byteLength(encoded) > 128 * 1024)
      return yield* error(new Error("App registry is too large."));
    yield* fs.writeFileString(`${path}.tmp`, encoded, { mode: 0o600 });
    yield* fs.rename(`${path}.tmp`, path);
  });
  const request = Effect.fn("StandaloneApps.request")(function* (
    app: StandaloneAppDefinition,
    method: string,
    params: unknown,
  ) {
    let connection = connections.get(app.id);
    if (!connection || connection.stopped) {
      connection = yield* Effect.try({
        try: () => openStdioAppConnection(app.command, app.args, config.stateDir),
        catch: error,
      });
      connections.set(app.id, connection);
    }
    const current = connection;
    return yield* Effect.tryPromise({ try: () => current.request(method, params), catch: error });
  });
  const list = Effect.fn("StandaloneApps.list")(function* () {
    return (yield* read()).map(({ id, title, keywords }) => ({ id, title, keywords }));
  });
  const save = Effect.fn("StandaloneApps.save")(function* (definition: StandaloneAppDefinition) {
    const apps = yield* read();
    yield* writeRegistry([...apps.filter((app) => app.id !== definition.id), definition]);
    disconnect(definition.id);
  });
  const remove = Effect.fn("StandaloneApps.remove")(function* (id: string) {
    yield* writeRegistry((yield* read()).filter((app) => app.id !== id));
    disconnect(id);
  });
  const open = Effect.fn("StandaloneApps.open")(function* (id: string) {
    const app = yield* find(id);
    const resource = yield* decodeResource(
      yield* request(app, "resources/read", { uri: app.resourceUri }),
    );
    const content = resource.contents.find(
      (entry) =>
        entry.uri === app.resourceUri &&
        entry.mimeType === "text/html;profile=mcp-app" &&
        entry.text !== undefined,
    );
    if (!content?.text || Buffer.byteLength(content.text) > 5 * 1024 * 1024)
      return yield* error(
        new Error(
          "App server did not return a supported HTML app. Update the extension and reopen it.",
        ),
      );
    return {
      html: content.text,
      resourceUri: app.resourceUri,
      writeTools: app.writeTools,
      readTools: app.readTools,
    };
  });
  const call = Effect.fn("StandaloneApps.call")(function* (
    input: { appId: string; name: string; arguments: Record<string, unknown> },
    write: boolean,
  ) {
    const app = yield* find(input.appId);
    const allowed = write ? app.writeTools : app.readTools;
    if (!allowed.includes(input.name))
      return yield* error(new Error("This tool is not allowed for this app action."));
    // A read RPC must never become a write because an extension mislabeled its manifest.
    if (!write) {
      let cursor: string | undefined;
      let readOnly = false;
      for (let page = 0; page < 10; page++) {
        const result = yield* decodeTools(
          yield* request(app, "tools/list", cursor ? { cursor } : {}),
        );
        const tool = result.tools.find((entry) => entry.name === input.name);
        if (tool) {
          readOnly = tool.annotations?.readOnlyHint === true;
          break;
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      if (!readOnly)
        return yield* error(new Error("App tool is not declared read-only by its server."));
    }
    return yield* decodeResult(
      yield* request(app, "tools/call", { name: input.name, arguments: input.arguments }),
    );
  });
  return StandaloneApps.of({
    list: Effect.fn("StandaloneApps.listAction")(function* () {
      return yield* list().pipe(Effect.mapError(error));
    }),
    save: Effect.fn("StandaloneApps.saveAction")(function* (app: StandaloneAppDefinition) {
      yield* save(app).pipe(lock.withPermits(1), Effect.mapError(error));
    }),
    remove: Effect.fn("StandaloneApps.removeAction")(function* (id: string) {
      yield* remove(id).pipe(lock.withPermits(1), Effect.mapError(error));
    }),
    open: Effect.fn("StandaloneApps.openAction")(function* (id: string) {
      return yield* open(id).pipe(lock.withPermits(1), Effect.mapError(error));
    }),
    call: Effect.fn("StandaloneApps.callAction")(function* (
      input: { appId: string; name: string; arguments: Record<string, unknown> },
      write: boolean,
    ) {
      return yield* call(input, write).pipe(lock.withPermits(1), Effect.mapError(error));
    }),
  });
});
export const layer = Layer.effect(StandaloneApps, make);
