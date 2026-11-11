import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SharedProjectEnrollment from "./SharedProjectEnrollment.ts";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
const read = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = new URL(request.url, "http://localhost").pathname;
  const match = /^\/api\/shared-projects\/([a-zA-Z0-9_.-]+)$/.exec(path);
  if (!match) return HttpServerResponse.empty({ status: 404, headers });
  const service = yield* SharedProjectEnrollment.SharedProjectEnrollment;
  return yield* service
    .serve(
      match[1]!,
      request.headers["t3-project-destination"] ?? "",
      request.headers.authorization?.replace(/^Bearer\s+/, "") ?? "",
    )
    .pipe(
      Effect.flatMap((manifest) => HttpServerResponse.json(manifest, { headers })),
      Effect.catchTags({
        SharedProjectError: (error) =>
          HttpServerResponse.json(
            { reason: error.reason, message: error.message },
            {
              headers,
              status: error.reason === "denied" ? 403 : error.reason === "not-found" ? 404 : 400,
            },
          ),
      }),
    );
});
export const layer = HttpRouter.add("GET", "/api/shared-projects/:id", read);
