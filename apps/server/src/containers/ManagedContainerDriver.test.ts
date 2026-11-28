import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { makeManagedContainerDriver } from "./ManagedContainerDriver.ts";

const id = "a".repeat(64);
const image = `sha256:${"b".repeat(64)}`;
const owner = {
  engineId: "engine-a",
  workspaceId: "workspace-a",
  resourceId: "resource-a",
  name: "t3-resource-a",
};
const spec = {
  threadId: ThreadId.make("thread-a"),
  requestId: "request-a",
  image,
  command: ["sleep", "600"],
  mountWorkspace: true,
  ports: [3000],
};
const options = { platform: "darwin", environment: { DOCKER_HOST: "unix:///socket" } };
function output(stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput {
  return {
    stdout,
    stderr,
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}
const info = output('{"id":"engine-a","name":"local","osType":"linux"}');
const owned = (state = "running", resource = owner.resourceId) =>
  output(JSON.stringify({ id, workspace: owner.workspaceId, resource, state }));

it.effect("refuses a changed engine before checking or changing a container", () =>
  Effect.gen(function* () {
    const driver = yield* makeManagedContainerDriver(options);
    const result = yield* driver
      .control({ ...owner, engineId: "other-engine" }, id, "release")
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "engine-changed");
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        assert.equal(input.args[2], "info");
        return Effect.succeed(info);
      },
    }),
  ),
);

it.effect("does not stop or remove a container with mismatched ownership labels", () =>
  Effect.gen(function* () {
    const driver = yield* makeManagedContainerDriver(options);
    const result = yield* driver.control(owner, id, "release").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "ownership");
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        assert.include(["info", "inspect"], input.args[2]);
        return Effect.succeed(
          input.args[2] === "info" ? info : owned("running", "some-other-owner"),
        );
      },
    }),
  ),
);

it.effect(
  "recovers an already-created container without creating another or reading image secrets",
  () =>
    Effect.gen(function* () {
      const driver = yield* makeManagedContainerDriver(options);
      assert.equal(yield* driver.ensureCreated(owner, spec, "/workspace/root"), id);
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          assert.include(["info", "inspect"], input.args[2]);
          if (input.args[2] === "inspect") assert.equal(input.args.at(-1), owner.name);
          return Effect.succeed(input.args[2] === "info" ? info : owned("created"));
        },
      }),
    ),
);

it.effect("rejects images declaring volumes without creating a container", () =>
  Effect.gen(function* () {
    const driver = yield* makeManagedContainerDriver(options);
    const result = yield* driver.ensureCreated(owner, spec, "/workspace/root").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid-image");
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        const operation = input.args[2];
        if (operation === "info") return Effect.succeed(info);
        if (operation === "inspect") return Effect.succeed(output("", 1, "No such container"));
        assert.equal(operation, "image");
        assert.isFalse(input.args.join(" ").includes(".Config.Env"));
        return Effect.succeed(output(JSON.stringify({ id: image, volumes: { "/data": {} } })));
      },
    }),
  ),
);

it.effect(
  "verifies ownership again after graceful stop and never forces deletion or removes volumes",
  () => {
    let state = "running";
    const operations: string[] = [];
    return Effect.gen(function* () {
      const driver = yield* makeManagedContainerDriver(options);
      yield* driver.control(owner, id, "release");
      assert.deepEqual(operations, ["info", "inspect", "stop", "inspect", "rm"]);
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          const operation = input.args[2]!;
          operations.push(operation);
          if (operation === "info") return Effect.succeed(info);
          if (operation === "inspect") return Effect.succeed(owned(state));
          assert.equal(input.args.at(-1), id);
          assert.isFalse(input.args.includes("--force"));
          assert.isFalse(input.args.includes("--volumes"));
          if (operation === "stop") state = "exited";
          return Effect.succeed(output(id));
        },
      }),
    );
  },
);

it.effect("treats a missing exact container as an acknowledged release", () =>
  Effect.gen(function* () {
    const driver = yield* makeManagedContainerDriver(options);
    yield* driver.control(owner, id, "release");
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        assert.include(["info", "inspect"], input.args[2]);
        return Effect.succeed(input.args[2] === "info" ? info : output("", 1, "No such container"));
      },
    }),
  ),
);
