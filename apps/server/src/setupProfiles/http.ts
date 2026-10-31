import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as SetupProfiles from "./SetupProfiles.ts";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
const read = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://localhost");
  const match = /^\/api\/setup-profiles\/([a-zA-Z0-9_.-]+)(?:\/blobs\/([a-f0-9]{64}))?$/.exec(
    url.pathname,
  );
  if (!match) return HttpServerResponse.empty({ status: 404, headers });
  const service = yield* SetupProfiles.SetupProfiles;
  const revision = url.searchParams.get("revision");
  if (revision !== null && !/^[1-9][0-9]{0,9}$/.test(revision))
    return HttpServerResponse.empty({ status: 400, headers });
  return yield* service
    .serve({
      profileId: match[1]!,
      destinationId: request.headers["t3-setup-destination"] ?? "",
      token: request.headers.authorization?.replace(/^Bearer\s+/, "") ?? "",
      ...(revision === null ? {} : { revision: Number(revision) }),
      ...(match[2] ? { digest: match[2] } : {}),
    })
    .pipe(
      Effect.flatMap((value) =>
        value instanceof Uint8Array
          ? Effect.succeed(HttpServerResponse.uint8Array(value, { headers }))
          : request.headers["if-none-match"] === `"${value.revision}"`
            ? Effect.succeed(
                HttpServerResponse.empty({
                  status: 304,
                  headers: { ...headers, etag: `"${value.revision}"` },
                }),
              )
            : HttpServerResponse.json(value, {
                headers: { ...headers, etag: `"${value.revision}"` },
              }),
      ),
      Effect.catchTags({
        SetupProfileError: (error) =>
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

export const layer = Layer.mergeAll(
  HttpRouter.add("GET", "/api/setup-profiles/:id", read),
  HttpRouter.add("GET", "/api/setup-profiles/:id/blobs/:digest", read),
);
