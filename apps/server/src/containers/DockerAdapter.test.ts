import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { makeDockerAdapter } from "./DockerAdapter.ts";

const id = "a".repeat(64);
const output = (stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.effect("refuses remote Docker endpoints before connecting or enumerating containers", () =>
  Effect.gen(function* () {
    const adapter = yield* makeDockerAdapter({
      platform: "darwin",
      environment: { DOCKER_HOST: "ssh://production" },
    });
    const result = yield* adapter.inventory.pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.status, "unsupported");
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () => Effect.die("Remote endpoint must not be contacted"),
    }),
  ),
);

it.effect(
  "keeps enumerated membership when inspect or stats fail and excludes raw container secrets",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeDockerAdapter({
        platform: "darwin",
        environment: { DOCKER_HOST: "unix:///socket" },
      });
      const inventory = yield* adapter.inventory;
      assert.equal(inventory.engineId, "engine-a");
      assert.isFalse(inventory.complete);
      assert.equal(inventory.containers.length, 2);
      const found = inventory.containers.find((container) => container.id === id)!;
      assert.equal(found.name, "api");
      assert.isNull(found.cpuPercent);
      assert.isNull(found.memoryBytes);
      assert.deepEqual(found.bindSources, ["/repo/api"]);
      assert.equal(inventory.containers.find((container) => container.id !== id)?.available, false);
      assert.isFalse(JSON.stringify(inventory).includes("PRIVATE_TOKEN"));
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          assert.equal(input.command, "docker");
          assert.equal(input.env?.DOCKER_CONTEXT, "");
          const operation = input.args[2];
          if (operation === "info")
            return Effect.succeed(
              output('{"id":"engine-a","name":"Docker Desktop","osType":"linux"}'),
            );
          if (operation === "ps") return Effect.succeed(output(`${id}\n${"b".repeat(64)}\n`));
          if (operation === "inspect") {
            const format = input.args[input.args.indexOf("--format") + 1]!;
            assert.isFalse(format.includes(".Config.Env"));
            assert.isFalse(format.includes("json .}}"));
            return Effect.succeed(
              output(
                JSON.stringify({
                  id,
                  name: "/api",
                  image: "api:local",
                  state: "running",
                  health: null,
                  restartCount: 0,
                  startedAt: null,
                  finishedAt: null,
                  composeProject: "api",
                  composeService: "web",
                  workingDirectory: "/repo/api",
                  configFiles: "/repo/api/compose.yaml",
                  mounts: [{ Type: "bind", Source: "/repo/api" }],
                  ports: {},
                  PRIVATE_TOKEN: "must-not-leak",
                }),
                1,
                "one container disappeared",
              ),
            );
          }
          assert.equal(operation, "stats");
          return Effect.succeed(output("", 1, "stats unavailable"));
        },
      }),
    ),
);
