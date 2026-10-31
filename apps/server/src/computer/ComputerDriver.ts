import { ComputerDriverResult, ComputerUseError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as ProcessRunner from "../processRunner.ts";

export class ComputerDriver extends Context.Service<
  ComputerDriver,
  {
    readonly call: (
      command: string,
      tool: string,
      input: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<typeof ComputerDriverResult.Type, ComputerUseError>;
  }
>()("t3/computer/ComputerDriver") {}
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isMcpResult = Schema.is(ComputerDriverResult);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const checked = yield* Ref.make<ReadonlySet<string>>(new Set());
  return ComputerDriver.of({
    call: Effect.fn("ComputerDriver.call")(function* (command, tool, input) {
      if (!(yield* Ref.get(checked)).has(command)) {
        const version = yield* runner
          .run({ command, args: ["--version"], timeout: "5 seconds", maxOutputBytes: 4096 })
          .pipe(Effect.mapError((cause) => new ComputerUseError({ reason: "unavailable", cause })));
        const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
        if (version.code !== 0 || !match || (Number(match[1]) === 0 && Number(match[2]) < 38))
          return yield* new ComputerUseError({ reason: "unsupported-version" });
        yield* Ref.update(checked, (values) => new Set([...values, command]));
      }
      const body = yield* encode(input).pipe(
        Effect.mapError((cause) => new ComputerUseError({ reason: "driver", cause })),
      );
      const result = yield* runner
        .run({
          command,
          args: ["call", tool],
          stdin: body,
          timeout: "15 seconds",
          maxOutputBytes: 12 * 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => new ComputerUseError({ reason: "unavailable", cause })));
      if (result.code !== 0 || result.stdoutTruncated || result.stdoutInvalidUtf8)
        return yield* new ComputerUseError({ reason: "driver" });
      const parsed = yield* decode(result.stdout).pipe(Effect.result);
      if (parsed._tag === "Failure")
        return { content: [{ type: "text" as const, text: result.stdout }] };
      if (isMcpResult(parsed.success)) {
        if (parsed.success.isError) return yield* new ComputerUseError({ reason: "driver" });
        return parsed.success;
      }
      // The CLI emits structuredContent directly, unlike its MCP transport.
      if (isRecord(parsed.success)) {
        const {
          screenshot_png_b64: image,
          screenshot_mime_type: mime,
          ...metadata
        } = parsed.success;
        const text = yield* encode(metadata).pipe(
          Effect.mapError((cause) => new ComputerUseError({ reason: "driver", cause })),
        );
        return {
          content: [
            { type: "text" as const, text },
            ...(typeof image === "string"
              ? [
                  {
                    type: "image" as const,
                    data: image,
                    mimeType: typeof mime === "string" ? mime : "image/png",
                  },
                ]
              : []),
          ],
        };
      }
      return { content: [{ type: "text" as const, text: result.stdout }] };
    }),
  });
});
export const layer = Layer.effect(ComputerDriver, make);
