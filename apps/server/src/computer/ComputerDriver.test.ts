import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ComputerDriver from "./ComputerDriver.ts";
import * as ProcessRunner from "../processRunner.ts";

const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
it.effect(
  "normalizes Cua CLI structured captures into text and image blocks, keeping input out of argv",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
      const layer = ComputerDriver.layer.pipe(
        Layer.provide(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Ref.update(calls, (values) => [...values, input]).pipe(
                Effect.as(
                  output(
                    input.args[0] === "--version"
                      ? "cua-driver 0.38.0"
                      : '{"snapshot_id":"s1","screenshot_png_b64":"test-image","screenshot_mime_type":"image/png"}',
                  ),
                ),
              ),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const driver = yield* ComputerDriver.ComputerDriver;
        const result = yield* driver.call("/tools/cua-driver", "get_window_state", {
          privateText: "private-input",
        });
        assert.equal(result.content.length, 2);
        assert.equal(result.content[1]?.type, "image");
        assert.isFalse(
          result.content[0]?.type === "text" && result.content[0].text.includes("test-image"),
        );
        yield* driver.call("/tools/cua-driver", "check_permissions", { prompt: false });
        const requests = yield* Ref.get(calls);
        assert.equal(requests.filter((request) => request.args[0] === "--version").length, 1);
        assert.isFalse(
          requests.some((request) => request.args.some((arg) => arg.includes("private-input"))),
        );
        assert.isTrue(requests.some((request) => request.stdin?.includes("private-input")));
      }).pipe(Effect.provide(layer));
    }),
);
it.effect("refuses unsupported driver versions before dispatching a desktop tool", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const layer = ComputerDriver.layer.pipe(
      Layer.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Ref.update(calls, (value) => value + 1).pipe(Effect.as(output("cua-driver 0.20.0"))),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const result = yield* (yield* ComputerDriver.ComputerDriver)
        .call("driver", "click", { x: 0, y: 0 })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(yield* Ref.get(calls), 1);
    }).pipe(Effect.provide(layer));
  }),
);
