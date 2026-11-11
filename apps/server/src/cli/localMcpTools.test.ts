import { expect, it } from "@effect/vitest";
import { SharedProjectContentError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeLocalMcpTools } from "./localMcpTools.ts";

const tools = (value: unknown) =>
  makeLocalMcpTools({ call: () => Effect.succeed(value) }, "http://127.0.0.1:3000");
const encodeContentError = Schema.encodeEffect(Schema.fromJsonString(SharedProjectContentError));
const resultSchema = Schema.Struct({ count: Schema.Int });
it.effect("refuses mismatched server results and preserves curated server failure messages", () =>
  Effect.gen(function* () {
    expect(
      yield* tools({ structuredContent: { count: 3 } }).call("test", {}, resultSchema),
    ).toEqual({ count: 3 });
    for (const response of [
      { structuredContent: { count: "wrong type" } },
      {},
      { content: "malformed" },
    ]) {
      const result = yield* tools(response).call("test", {}, resultSchema).pipe(Effect.result);
      if (result._tag !== "Failure") return expect.fail("Expected malformed result rejection");
      expect(result.failure._tag).toBe("McpToolFailedError");
      expect(result.failure.message).toContain("Update the t3 CLI");
    }
    const failure = new SharedProjectContentError({ reason: "stale", origin: "owner" });
    const text = yield* encodeContentError(failure);
    const result = yield* tools({ isError: true, content: [{ type: "text", text }] })
      .call("test", {}, resultSchema)
      .pipe(Effect.result);
    if (result._tag !== "Failure") return expect.fail("Expected server error");
    expect(result.failure.message).toBe(failure.message);
  }),
);
