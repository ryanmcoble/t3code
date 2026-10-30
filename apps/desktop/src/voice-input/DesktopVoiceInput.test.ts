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
import { make as makeVoiceShortcut } from "./DesktopVoiceShortcut.ts";
import { make as makeVoiceRecording } from "./DesktopVoiceRecording.ts";

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
  stdin: ChildProcessSpawner.ChildProcessHandle["stdin"] = Sink.drain,
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin,
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
  it.effect("records natively without a focused renderer and removes audio after finish", () =>
    Effect.gen(function* () {
      const { environment, fs, helper } = yield* fixture;
      const stopped = yield* Deferred.make<void>();
      let file = "";
      let closed = false;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
            assert.equal(command.command, helper);
            assert.equal(command.args[0], "record");
            file = command.args[1]!;
            yield* fs.writeFile(file, new Uint8Array([1, 2, 3]));
            return handle(
              Stream.concat(
                Stream.make(new TextEncoder().encode('{"event":"ready"}\n')),
                Stream.fromEffect(
                  Deferred.await(stopped).pipe(
                    Effect.as(new TextEncoder().encode('{"event":"finished"}\n')),
                  ),
                ),
              ),
              Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              Sink.forEach((bytes: Uint8Array) =>
                Effect.gen(function* () {
                  assert.equal(new TextDecoder().decode(bytes), "stop\n");
                  yield* Deferred.succeed(stopped, undefined);
                }),
              ),
            );
          }),
          () =>
            Effect.sync(() => {
              closed = true;
            }),
        ),
      );
      const service = yield* makeVoiceRecording.pipe(
        Effect.provide(environment),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* service.prepare("recording");
      assert.isTrue(yield* fs.exists(file));
      assert.include((yield* service.prepare("other").pipe(Effect.flip)).message, "already active");
      assert.deepEqual(yield* service.finish("recording"), new Uint8Array([1, 2, 3]));
      assert.isTrue(closed);
      assert.isFalse(yield* fs.exists(file));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels native microphone preparation and settles its waiting request", () =>
    Effect.gen(function* () {
      const { environment, fs } = yield* fixture;
      const entered = yield* Deferred.make<void>();
      let file = "";
      let closed = false;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
            file = command.args[1]!;
            yield* Deferred.succeed(entered, undefined);
            return handle(Stream.never, Effect.never);
          }),
          () =>
            Effect.sync(() => {
              closed = true;
            }),
        ),
      );
      const service = yield* makeVoiceRecording.pipe(
        Effect.provide(environment),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const preparing = yield* service.prepare("recording").pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.cancel("recording");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(preparing)));
      assert.isTrue(closed);
      assert.isFalse(yield* fs.exists(file));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "replaces a global shortcut only after its old helper exits and ignores stale lease cleanup",
    () =>
      Effect.gen(function* () {
        const { environment, helper } = yield* fixture;
        let opened = 0;
        let closed = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              assert.equal(opened, closed);
              opened++;
              assert.equal(command._tag, "StandardCommand");
              if (command._tag === "StandardCommand") {
                assert.equal(command.command, helper);
                assert.deepEqual(command.args, ["hotkey", "d", "768"]);
              }
              return handle(
                Stream.concat(
                  Stream.make(new TextEncoder().encode('{"event":"ready"}\n')),
                  Stream.never,
                ),
                Effect.never,
              );
            }),
            () =>
              Effect.sync(() => {
                closed++;
              }),
          ),
        );
        const service = yield* makeVoiceShortcut.pipe(
          Effect.provide(environment),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const config = {
          enabled: true,
          shortcut: {
            key: "d",
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
            modKey: true,
          },
        };
        yield* service.configure({ ...config, ownerKey: "first" });
        yield* service.configure({ ...config, ownerKey: "second" });
        assert.equal(opened, 2);
        assert.equal(closed, 1);
        yield* service.configure({ ownerKey: "first", enabled: false, shortcut: null });
        assert.equal(closed, 1);
        yield* service.configure({ ownerKey: "second", enabled: false, shortcut: null });
        assert.equal(closed, 2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports native shortcut conflicts and releases failed helpers", () =>
    Effect.gen(function* () {
      const { environment } = yield* fixture;
      let closed = false;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.acquireRelease(
          Effect.succeed(
            handle(
              Stream.make(new TextEncoder().encode('{"error":"Shortcut already in use"}\n')),
              Effect.never,
            ),
          ),
          () =>
            Effect.sync(() => {
              closed = true;
            }),
        ),
      );
      const service = yield* makeVoiceShortcut.pipe(
        Effect.provide(environment),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const error = yield* service
        .configure({
          ownerKey: "first",
          enabled: true,
          shortcut: {
            key: "d",
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
            modKey: true,
          },
        })
        .pipe(Effect.flip);
      assert.equal(error.message, "Shortcut already in use");
      assert.isTrue(closed);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
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
