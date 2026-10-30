import type { DesktopVoiceInputRequest, DesktopVoiceInputResult } from "@t3tools/contracts";
import {
  listVoiceServerModels,
  transcribeOnVoiceServer,
} from "@t3tools/client-runtime/voice-input";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { runNativeTranscription } from "./nativeTranscription.ts";

export class DesktopVoiceInputError extends Schema.TaggedError<DesktopVoiceInputError>()(
  "DesktopVoiceInputError",
  { message: Schema.String },
) {}

export class DesktopVoiceInput extends Context.Service<
  DesktopVoiceInput,
  {
    readonly run: (
      request: DesktopVoiceInputRequest,
    ) => Effect.Effect<DesktopVoiceInputResult, DesktopVoiceInputError>;
    readonly cancel: (id: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/voice-input/DesktopVoiceInput") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  const active = new Map<string, Fiber.Fiber<DesktopVoiceInputResult, DesktopVoiceInputError>>();
  yield* Effect.addFinalizer(() => Fiber.interruptAll(active.values()));

  const execute = Effect.fn("desktop.voiceInput.execute")(
    function* (request: DesktopVoiceInputRequest) {
      const result: DesktopVoiceInputResult = {
        available: true,
        installed: true,
        locale: request.locale,
        text: "",
        models: [],
      };
      if (request.action === "test-server") {
        const models = yield* Effect.tryPromise({
          try: (signal) => listVoiceServerModels(request.settings, signal),
          catch: (cause) =>
            new DesktopVoiceInputError({
              message:
                cause instanceof Error
                  ? cause.message
                  : "Could not connect to the transcription server.",
            }),
        });
        return { ...result, models };
      }
      if (request.settings.engine === "server") {
        if (request.action !== "transcribe") return result;
        if (!request.audio)
          return yield* new DesktopVoiceInputError({ message: "Missing voice recording." });
        const audio = new Blob([new Uint8Array(request.audio)], { type: "audio/wav" });
        const text = yield* Effect.tryPromise({
          try: (signal) => transcribeOnVoiceServer(request.settings, audio, signal),
          catch: (cause) =>
            new DesktopVoiceInputError({
              message: cause instanceof Error ? cause.message : "Voice transcription failed.",
            }),
        });
        return { ...result, text };
      }
      const unavailable = { ...result, available: false, installed: false };
      if (environment.platform !== "darwin" || request.settings.engine === "off")
        return unavailable;
      const candidates = [
        ...environment.resolveResourcePathCandidates("voice-input/t3-transcription"),
        path.join(
          environment.rootDir,
          "native/apple-transcription/build",
          environment.processArch,
          "t3-transcription",
        ),
      ];
      let executable: string | undefined;
      for (const candidate of candidates) {
        if (yield* fs.exists(candidate)) {
          executable = candidate;
          break;
        }
      }
      if (!executable) {
        if (request.action === "capabilities") return unavailable;
        return yield* new DesktopVoiceInputError({
          message: "The Apple transcription helper is missing from this desktop build.",
        });
      }
      const args = [request.action, request.locale];
      if (request.action !== "transcribe")
        return { ...result, ...(yield* runNativeTranscription(executable, args)) };
      if (!request.audio)
        return yield* new DesktopVoiceInputError({ message: "Missing voice recording." });
      const audio = request.audio;
      const helper = executable;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dictation-" });
          const audioPath = path.join(directory, "dictation.wav");
          yield* fs.writeFile(audioPath, audio, { mode: 0o600 });
          return { ...result, ...(yield* runNativeTranscription(helper, [...args, audioPath])) };
        }),
      );
    },
    Effect.mapError(
      (cause) =>
        new DesktopVoiceInputError({
          message: cause instanceof Error ? cause.message : "Voice transcription failed.",
        }),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  return DesktopVoiceInput.of({
    run: Effect.fn("desktop.voiceInput.run")(function* (request) {
      if (active.has(request.id))
        return yield* new DesktopVoiceInputError({
          message: "This voice operation is already running.",
        });
      const fiber = yield* execute(request).pipe(Effect.forkChild());
      active.set(request.id, fiber);
      return yield* Fiber.join(fiber).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(request.id);
          }),
        ),
      );
    }),
    cancel: Effect.fn("desktop.voiceInput.cancel")(function* (id) {
      const fiber = active.get(id);
      if (fiber) yield* Fiber.interrupt(fiber);
    }),
  });
});

export const layer = Layer.effect(DesktopVoiceInput, make);
