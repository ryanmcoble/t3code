import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const NativeResult = Schema.Struct({
  available: Schema.optionalKey(Schema.Boolean),
  locale: Schema.optionalKey(Schema.String),
  installed: Schema.optionalKey(Schema.Boolean),
  text: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
const decodeNativeResult = Schema.decodeEffect(Schema.fromJsonString(NativeResult));
class NativeTranscriptionError extends Schema.TaggedError<NativeTranscriptionError>()(
  "NativeTranscriptionError",
  { message: Schema.String },
) {}

export const runNativeTranscription = Effect.fn("desktop.voiceInput.native")(function* (
  executable: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: "2 seconds",
        }),
      );
      const [output, , code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const result = yield* decodeNativeResult(output);
      if (Number(code) !== 0 || result.error)
        return yield* new NativeTranscriptionError({
          message: result.error ?? "Apple transcription failed.",
        });
      return result;
    }),
  );
});
