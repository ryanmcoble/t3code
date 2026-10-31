import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DesktopVoiceInputError } from "./DesktopVoiceInput.ts";
import { nativeTranscriptionCandidates } from "./nativeTranscription.ts";
import { VOICE_RECORDING_LIMIT_SECONDS } from "@t3tools/client-runtime/voice-input";

const decode = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      event: Schema.optionalKey(Schema.String),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
);
const isVoiceError = Schema.is(DesktopVoiceInputError);

export class DesktopVoiceRecording extends Context.Service<
  DesktopVoiceRecording,
  {
    readonly prepare: (id: string) => Effect.Effect<void, DesktopVoiceInputError>;
    readonly finish: (id: string) => Effect.Effect<Uint8Array, DesktopVoiceInputError>;
    readonly cancel: (id: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/voice-input/DesktopVoiceRecording") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const recordings = new Map<
    string,
    {
      fiber: Fiber.Fiber<Uint8Array, DesktopVoiceInputError>;
      stop: Deferred.Deferred<void>;
      ready: Deferred.Deferred<void, DesktopVoiceInputError>;
    }
  >();

  return DesktopVoiceRecording.of({
    prepare: Effect.fn("desktop.voiceInput.prepareRecording")(function* (id) {
      if (recordings.size > 0)
        return yield* new DesktopVoiceInputError({ message: "Voice recording is already active." });
      const ready = yield* Deferred.make<void, DesktopVoiceInputError>();
      const stop = yield* Deferred.make<void>();
      const operation = Effect.scoped(
        Effect.gen(function* () {
          if (environment.platform !== "darwin")
            return yield* new DesktopVoiceInputError({
              message: "Native voice recording requires the Mac desktop app.",
            });
          let executable: string | undefined;
          for (const candidate of nativeTranscriptionCandidates(environment)) {
            if (yield* fs.exists(candidate)) {
              executable = candidate;
              break;
            }
          }
          if (!executable)
            return yield* new DesktopVoiceInputError({
              message: "The native recording helper is missing. Reinstall the desktop app.",
            });
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-recording-" });
          const file = environment.path.join(directory, "recording.wav");
          const child = yield* spawner.spawn(
            ChildProcess.make(executable, ["record", file, String(VOICE_RECORDING_LIMIT_SECONDS)], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter: "2 seconds",
            }),
          );
          yield* child.stderr.pipe(Stream.runDrain, Effect.forkChild);
          yield* Deferred.await(stop).pipe(
            Effect.andThen(
              Stream.make(new TextEncoder().encode("stop\n")).pipe(Stream.run(child.stdin)),
            ),
            Effect.forkChild,
          );
          let finished = false;
          yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.gen(function* () {
                if (!line.trim()) return;
                const event = yield* decode(line);
                if (event.error) return yield* new DesktopVoiceInputError({ message: event.error });
                if (event.event === "ready") yield* Deferred.succeed(ready, undefined);
                if (event.event === "finished") finished = true;
              }),
            ),
          );
          const code = yield* child.exitCode;
          if (!finished || Number(code) !== 0)
            return yield* new DesktopVoiceInputError({
              message: "Voice recording did not finish.",
            });
          return yield* fs.readFile(file);
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isVoiceError(cause)
            ? cause
            : new DesktopVoiceInputError({ message: "Could not record from the microphone." }),
        ),
        Effect.tapError((error) => Deferred.fail(ready, error)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const fiber = yield* operation.pipe(Effect.forkIn(scope));
      recordings.set(id, { fiber, stop, ready });
      yield* Deferred.await(ready).pipe(
        Effect.tapError(() => Effect.sync(() => recordings.delete(id))),
      );
    }),
    finish: Effect.fn("desktop.voiceInput.finishRecording")(function* (id) {
      const active = recordings.get(id);
      if (!active)
        return yield* new DesktopVoiceInputError({
          message: "This recording is no longer available.",
        });
      yield* Deferred.succeed(active.stop, undefined);
      return yield* Fiber.join(active.fiber).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            recordings.delete(id);
          }),
        ),
      );
    }),
    cancel: Effect.fn("desktop.voiceInput.cancelRecording")(function* (id) {
      const active = recordings.get(id);
      if (active) {
        yield* Fiber.interrupt(active.fiber);
        yield* Deferred.fail(
          active.ready,
          new DesktopVoiceInputError({ message: "Recording cancelled." }),
        );
      }
      recordings.delete(id);
    }),
  });
});

export const layer = Layer.effect(DesktopVoiceRecording, make);
