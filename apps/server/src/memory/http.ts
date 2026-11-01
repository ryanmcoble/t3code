import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Schema from "effect/Schema";
import * as SharedMemory from "./SharedMemory.ts";

const decode = Schema.decodeUnknownEffect(SharedMemory.MemoryWireRequest);
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const serve = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const memory = yield* SharedMemory.SharedMemory;
  const input = yield* request.json.pipe(Effect.flatMap(decode));
  return yield* memory
    .serve(request.headers.authorization?.replace(/^Bearer\s+/, "") ?? "", input)
    .pipe(Effect.flatMap((result) => HttpServerResponse.json(result, { headers })));
}).pipe(
  Effect.catch((error) =>
    HttpServerResponse.json(
      { message: "The memory request could not be completed." },
      {
        headers,
        status:
          error._tag === "SharedMemoryError"
            ? error.reason === "denied"
              ? 403
              : error.reason === "conflict"
                ? 409
                : 400
            : 400,
      },
    ),
  ),
);
export const layer = HttpRouter.add("POST", "/api/shared-memory", serve);
