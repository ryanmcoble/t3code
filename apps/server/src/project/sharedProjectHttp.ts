import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { SharedProjectContentRequest } from "@t3tools/contracts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SharedProjectEnrollment from "./SharedProjectEnrollment.ts";
import * as SharedProjectContentSource from "./SharedProjectContentSource.ts";

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
const content = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = new URL(request.url, "http://localhost").pathname;
  const match = /^\/api\/shared-projects\/([a-zA-Z0-9_.-]+)\/content$/.exec(path);
  if (!match) return HttpServerResponse.empty({ status: 404, headers });
  const service = yield* SharedProjectContentSource.SharedProjectContentSource;
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)),
    Effect.flatMap(Schema.decodeUnknownEffect(SharedProjectContentRequest)),
    Effect.flatMap((body) =>
      service.request({
        projectId: match[1]!,
        destinationId: request.headers["t3-project-destination"] ?? "",
        token: request.headers.authorization?.replace(/^Bearer\s+/, "") ?? "",
        request: body,
      }),
    ),
    Effect.flatMap((response) => HttpServerResponse.json(response, { headers })),
    Effect.catchTags({
      SharedProjectError: (error) =>
        HttpServerResponse.json(
          { reason: error.reason, message: error.message },
          {
            headers,
            status: error.reason === "denied" ? 403 : error.reason === "not-found" ? 404 : 409,
          },
        ),
      SharedProjectContentError: (error) =>
        HttpServerResponse.json(
          { reason: error.reason, message: error.message },
          { headers, status: 409 },
        ),
    }),
    Effect.catch(() =>
      HttpServerResponse.json(
        { message: "Invalid project content request." },
        { headers, status: 400 },
      ),
    ),
  );
});
export const layer = Layer.mergeAll(
  HttpRouter.add("GET", "/api/shared-projects/:id", read),
  HttpRouter.add("POST", "/api/shared-projects/:id/content", content),
);
