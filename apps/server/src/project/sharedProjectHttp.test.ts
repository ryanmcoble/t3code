import { afterEach, expect, it } from "vite-plus/test";
import { SharedProjectError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as ContentSource from "./SharedProjectContentSource.ts";
import * as Enrollment from "./SharedProjectEnrollment.ts";
import * as SharedProjectHttp from "./sharedProjectHttp.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = () => {
  const calls: Array<
    Parameters<ContentSource.SharedProjectContentSource["Service"]["request"]>[0]
  > = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    SharedProjectHttp.layer.pipe(
      Layer.provideMerge(Layer.mock(Enrollment.SharedProjectEnrollment)({})),
      Layer.provideMerge(
        Layer.succeed(ContentSource.SharedProjectContentSource, {
          request: (input) =>
            Effect.gen(function* () {
              calls.push(input);
              if (input.token !== "test-only" || input.destinationId !== "member")
                return yield* new SharedProjectError({ reason: "denied" });
              return { kind: "ended" as const };
            }),
        }),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, calls };
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/shared-projects/sample/content", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const start = { operation: "start", rootId: "docs", expectedManifestRevision: 1 };

it("forwards exact recipient credentials, never caches bytes, and maps denied grants to 403", async () => {
  const test = fixture();
  const denied = await test.handler(post(start));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({
    reason: "denied",
    message: new SharedProjectError({ reason: "denied" }).message,
  });
  const result = await test.handler(
    post(start, { authorization: "Bearer test-only", "t3-project-destination": "member" }),
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await result.json()).toEqual({ kind: "ended" });
  expect(test.calls[1]).toEqual({
    projectId: "sample",
    destinationId: "member",
    token: "test-only",
    request: start,
  });
});

it("rejects oversized and invalid requests before opening a transfer", async () => {
  const test = fixture();
  for (const body of [
    { ...start, expectedManifestRevision: -1 },
    { operation: "read", sessionId: "test", relativePath: "README", offset: -1 },
    { ...start, rootId: "x".repeat(20_000) },
    { operation: "arbitrary-path", cwd: "/Users/ryan" },
  ]) {
    const response = await test.handler(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid project content request." });
  }
  expect(test.calls).toEqual([]);
});
