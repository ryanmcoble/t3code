// @effect-diagnostics nodeBuiltinImport:off - The subprocess fixture is resolved relative to this test module.
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as StandaloneApps from "./StandaloneApps.ts";

const definition = {
  id: "test-app",
  title: "Test App",
  keywords: ["test"],
  command: process.execPath,
  args: [NodeURL.fileURLToPath(new URL("./testkit/app-server.fixture.mjs", import.meta.url))],
  resourceUri: "ui://test/app",
  readTools: ["read", "write"],
  writeTools: ["write"],
};
const layer = StandaloneApps.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-standalone-app-test-" })),
  Layer.provide(NodeServices.layer),
);

it.live(
  "runs without an agent, reuses its connection, and enforces read/write tool boundaries",
  () =>
    Effect.gen(function* () {
      const apps = yield* StandaloneApps.StandaloneApps;
      yield* apps.save(definition);
      assert.deepEqual(yield* apps.list(), [
        { id: "test-app", title: "Test App", keywords: ["test"] },
      ]);
      const document = yield* apps.open("test-app");
      assert.include(document.html, "Test app");
      const read = () => apps.call({ appId: "test-app", name: "read", arguments: {} }, false);
      const before = yield* read();
      const decode = (result: typeof before) =>
        JSON.parse((result.content[0] as { text: string }).text) as { pid: number; writes: number };
      const initial = decode(before);
      assert.equal(initial.writes, 0);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(apps.call({ appId: "test-app", name: "write", arguments: {} }, false)),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            apps.call({ appId: "test-app", name: "unregistered", arguments: {} }, true),
          ),
        ),
      );
      assert.deepEqual(decode(yield* read()), initial);
      yield* apps.call({ appId: "test-app", name: "write", arguments: {} }, true);
      assert.deepEqual(decode(yield* read()), { ...initial, writes: 1 });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            apps.call(
              {
                appId: "test-app",
                name: "write",
                arguments: { crash: true },
              },
              true,
            ),
          ),
        ),
      );
      // A failed mutation is not replayed; only this explicit read reconnects.
      const recovered = decode(yield* read());
      assert.notEqual(recovered.pid, initial.pid);
      assert.equal(recovered.writes, 0);
      yield* apps.save(definition);
      const restarted = decode(yield* read());
      assert.notEqual(restarted.pid, recovered.pid);
      assert.equal(restarted.writes, 0);
      yield* apps.remove("test-app");
      assert.deepEqual(yield* apps.list(), []);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(apps.open("test-app"))));
    }).pipe(Effect.provide(layer), Effect.scoped),
);
