import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

export class DockerAdapterError extends Schema.TaggedError<DockerAdapterError>()(
  "DockerAdapterError",
  {
    status: Schema.Literals([
      "cli-missing",
      "engine-unavailable",
      "permission-denied",
      "unsupported",
    ]),
  },
) {}
const decodeHost = Schema.decodeEffect(Schema.fromJsonString(Schema.String));
const decodeInfo = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      osType: Schema.String,
    }),
  ),
);
const INFO_FORMAT = '{"id":{{json .ID}},"name":{{json .Name}},"osType":{{json .OSType}}}';
export const dockerErrorStatus = (
  output: ProcessRunner.ProcessRunOutput,
): "permission-denied" | "engine-unavailable" =>
  /permission denied|access is denied/i.test(output.stderr)
    ? "permission-denied"
    : "engine-unavailable";

export const makeDockerConnection = Effect.fn("DockerConnection.make")(function* (options: {
  readonly platform: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly command?: string;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const command = options.command ?? "docker";
  const invoke = (args: ReadonlyArray<string>, host?: string, maxOutputBytes = 4 * 1024 * 1024) =>
    runner
      .run({
        command,
        args: host ? ["--host", host, ...args] : args,
        env: host
          ? {
              ...options.environment,
              DOCKER_CONTEXT: "",
              DOCKER_HOST: host,
              DOCKER_TLS_VERIFY: "",
              DOCKER_CERT_PATH: "",
            }
          : options.environment,
        timeout: "10 seconds",
        maxOutputBytes,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new DockerAdapterError({
              status: error._tag === "ProcessSpawnError" ? "cli-missing" : "engine-unavailable",
            }),
        ),
      );

  const select = Effect.gen(function* () {
    if (options.platform !== "darwin" && options.platform !== "linux")
      return yield* new DockerAdapterError({ status: "unsupported" });
    let host = options.environment.DOCKER_CONTEXT?.trim()
      ? undefined
      : options.environment.DOCKER_HOST?.trim();
    if (!host) {
      const context = yield* invoke(
        [
          "context",
          "inspect",
          ...(options.environment.DOCKER_CONTEXT?.trim()
            ? [options.environment.DOCKER_CONTEXT.trim()]
            : []),
          "--format",
          "{{json .Endpoints.docker.Host}}",
        ],
        undefined,
        4096,
      );
      if (context.code !== 0 || context.stdoutTruncated)
        return yield* new DockerAdapterError({ status: dockerErrorStatus(context) });
      host = yield* decodeHost(context.stdout.trim()).pipe(
        Effect.mapError(() => new DockerAdapterError({ status: "unsupported" })),
      );
    }
    if (!host.startsWith("unix:///") || host.includes("\n"))
      return yield* new DockerAdapterError({ status: "unsupported" });
    const result = yield* invoke(["info", "--format", INFO_FORMAT], host, 16384);
    if (result.code !== 0 || result.stdoutTruncated)
      return yield* new DockerAdapterError({ status: dockerErrorStatus(result) });
    const info = yield* decodeInfo(result.stdout.trim()).pipe(
      Effect.mapError(() => new DockerAdapterError({ status: "engine-unavailable" })),
    );
    if (!info.id || info.osType !== "linux")
      return yield* new DockerAdapterError({ status: "unsupported" });
    return { host, id: info.id, name: info.name };
  });

  return { select, invoke };
});
