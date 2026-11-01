import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as SharedMemory from "./SharedMemory.ts";

export const start = Effect.gen(function* () {
  const memory = yield* SharedMemory.SharedMemory;
  yield* memory.recoverCaptureJobs;
  yield* memory.processCaptureJobs.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Memory extraction failed", { reason: error.reason }),
    ),
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.forkScoped,
  );
});
