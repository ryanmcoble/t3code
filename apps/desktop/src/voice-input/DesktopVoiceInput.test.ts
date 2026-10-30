import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_VOICE_INPUT_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import { make } from "./DesktopVoiceInput.ts";

const request = {
  id: "voice-operation",
  action: "transcribe" as const,
  settings: DEFAULT_VOICE_INPUT_SETTINGS,
  locale: "en-US",
  audio: new Uint8Array([1, 2, 3]),
};

const handle = (
  stdout: Stream.Stream<Uint8Array>,
  exitCode = Effect.succeed(ChildProcessSpawner.ExitCode(0)),
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-test-" });
  const helper = path.join(root, "voice-input", "t3-transcription");
  yield* fs.makeDirectory(path.dirname(helper), { recursive: true });
  yield* fs.writeFileString(helper, "test helper");
  const archivedHelper = path.join(
    root,
    "app.asar/apps/desktop/resources/voice-input/t3-transcription",
  );
  yield* fs.makeDirectory(path.dirname(archivedHelper), { recursive: true });
  yield* fs.writeFileString(archivedHelper, "archived helper");
  const environment = DesktopEnvironment.layer({
    platform: "darwin",
    processArch: "arm64",
    dirname: path.join(root, "app.asar/apps/desktop/dist-electron"),
    homeDirectory: root,
    appVersion: "0.0.0",
    appPath: path.join(root, "app.asar"),
    isPackaged: true,
    resourcesPath: root,
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(DesktopConfig.layerTest({})));
  return { fs, path, helper, environment };
});

describe("desktop voice input lifecycle", () => {
  it.effect("removes private temporary audio after success and native failures", () =>
    Effect.gen(function* () {
      const { fs, helper, environment } = yield* fixture;
      for (const response of [
        { output: '{"text":"spoken text"}', code: 0 },
        { output: '{"error":"Unsupported language"}', code: 1 },
        { output: "malformed native output", code: 0 },
      ]) {
        let audioPath = "";
        let executablePath = "";
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.equal(command._tag, "StandardCommand");
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipe");
            executablePath = command.command;
            audioPath = command.args[2]!;
            assert.deepEqual([...(yield* fs.readFile(audioPath))], [...request.audio]);
            assert.equal(Number((yield* fs.stat(audioPath)).mode) & 0o777, 0o600);
            return handle(
              Stream.encodeText(Stream.make(response.output)),
              Effect.succeed(ChildProcessSpawner.ExitCode(response.code)),
            );
          }),
        );
        const service = yield* make.pipe(
          Effect.provide(environment),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const result = yield* Effect.exit(service.run(request));
        assert.equal(executablePath, helper);
        if (response.code === 0 && response.output.startsWith("{")) {
          assert.isTrue(Exit.isSuccess(result));
          if (Exit.isSuccess(result)) assert.equal(result.value.text, "spoken text");
        } else assert.isTrue(Exit.isFailure(result));
        assert.isNotEmpty(audioPath);
        assert.isFalse(yield* fs.exists(audioPath));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels its native process and removes audio before cancellation finishes", () =>
    Effect.gen(function* () {
      const { fs, environment } = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      let audioPath = "";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipe");
            audioPath = command.args[2]!;
            return handle(
              Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
                Stream.flatMap(() => Stream.never),
              ),
              Effect.never,
            );
          }),
          () => Deferred.succeed(closed, undefined),
        ),
      );
      const service = yield* make.pipe(
        Effect.provide(environment),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const operation = yield* service.run(request).pipe(Effect.exit, Effect.forkChild());
      yield* Deferred.await(entered);
      assert.isTrue(yield* fs.exists(audioPath));
      yield* service.cancel(request.id);
      yield* Deferred.await(closed);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(operation)));
      assert.isFalse(yield* fs.exists(audioPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
