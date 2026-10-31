import type { DesktopVoiceShortcutConfig, DesktopVoiceShortcutEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DesktopVoiceInputError } from "./DesktopVoiceInput.ts";
import { nativeTranscriptionCandidates } from "./nativeTranscription.ts";

const NativeEvent = Schema.Struct({
  event: Schema.optionalKey(Schema.Literals(["ready", "pressed", "released"])),
  error: Schema.optionalKey(Schema.String),
});
const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(NativeEvent));
const isVoiceInputError = Schema.is(DesktopVoiceInputError);

export class DesktopVoiceShortcut extends Context.Service<
  DesktopVoiceShortcut,
  {
    readonly configure: (
      config: DesktopVoiceShortcutConfig,
    ) => Effect.Effect<void, DesktopVoiceInputError>;
    readonly events: Stream.Stream<DesktopVoiceShortcutEvent>;
  }
>()("@t3tools/desktop/voice-input/DesktopVoiceShortcut") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<DesktopVoiceShortcutEvent>();
  let active: { ownerKey: string; fiber: Fiber.Fiber<void> } | undefined;

  return DesktopVoiceShortcut.of({
    events: Stream.fromPubSub(events),
    configure: Effect.fn("desktop.voiceInput.configureShortcut")((config) =>
      mutex.withPermit(
        Effect.gen(function* () {
          if (!config.enabled && active?.ownerKey !== config.ownerKey) return;
          if (active) {
            const previous = active;
            active = undefined;
            yield* Fiber.interrupt(previous.fiber);
          }
          if (!config.enabled) return;
          if (environment.platform !== "darwin" || !config.shortcut)
            return yield* new DesktopVoiceInputError({
              message: "System-wide dictation shortcuts require the Mac desktop app.",
            });
          let executable: string | undefined;
          for (const candidate of nativeTranscriptionCandidates(environment)) {
            if (
              yield* fs.exists(candidate).pipe(
                Effect.mapError(
                  () =>
                    new DesktopVoiceInputError({
                      message: "Could not locate the global dictation helper.",
                    }),
                ),
              )
            ) {
              executable = candidate;
              break;
            }
          }
          if (!executable)
            return yield* new DesktopVoiceInputError({
              message: "The global dictation helper is missing. Reinstall the desktop app.",
            });
          const shortcut = config.shortcut;
          const modifiers =
            (shortcut.metaKey || shortcut.modKey ? 256 : 0) |
            (shortcut.shiftKey ? 512 : 0) |
            (shortcut.altKey ? 2048 : 0) |
            (shortcut.ctrlKey ? 4096 : 0);
          if (modifiers === 0 && !/^f(?:[1-9]|1[0-9]|20)$/.test(shortcut.key))
            return yield* new DesktopVoiceInputError({
              message: "Use a modifier key with the global dictation shortcut.",
            });
          const ready = yield* Deferred.make<void, DesktopVoiceInputError>();
          const operation = Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make(executable, ["hotkey", shortcut.key, String(modifiers)], {
                  stdin: "pipe",
                  stdout: "pipe",
                  stderr: "pipe",
                  killSignal: "SIGTERM",
                  forceKillAfter: "2 seconds",
                }),
              );
              yield* child.stderr.pipe(Stream.runDrain, Effect.forkChild);
              yield* child.stdout.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) =>
                  Effect.gen(function* () {
                    if (!line.trim()) return;
                    const message = yield* decodeEvent(line);
                    if (message.error)
                      return yield* new DesktopVoiceInputError({ message: message.error });
                    if (message.event === "ready") {
                      yield* Deferred.succeed(ready, undefined);
                      return;
                    }
                    if (message.event === "pressed" || message.event === "released")
                      yield* PubSub.publish(events, {
                        ownerKey: config.ownerKey,
                        type: message.event,
                      });
                  }),
                ),
              );
              return yield* new DesktopVoiceInputError({
                message:
                  "The global dictation shortcut stopped. Reopen the thread to register it again.",
              });
            }),
          ).pipe(
            Effect.catch((cause) => {
              const error = isVoiceInputError(cause)
                ? cause
                : new DesktopVoiceInputError({
                    message: "Could not register the global dictation shortcut.",
                  });
              return Deferred.fail(ready, error).pipe(
                Effect.andThen(
                  PubSub.publish(events, {
                    ownerKey: config.ownerKey,
                    type: "failed",
                    message: error.message,
                  }),
                ),
                Effect.asVoid,
              );
            }),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const fiber = yield* operation.pipe(Effect.forkIn(scope));
          active = { ownerKey: config.ownerKey, fiber };
          yield* Deferred.await(ready);
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopVoiceShortcut, make);
