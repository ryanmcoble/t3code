import {
  ContainerError,
  type ContainerRecord,
  type ContainerSnapshot,
  type ContainerTarget,
  type ContainerLogsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DockerAdapterError,
  dockerErrorStatus as errorStatus,
  makeDockerConnection,
} from "./DockerConnection.ts";
export { DockerAdapterError } from "./DockerConnection.ts";
import { parseDockerMemory } from "./DockerModel.ts";

type Inventory = Pick<ContainerSnapshot, "engineName" | "complete" | "containers" | "message"> & {
  readonly engineId: string;
};
export class DockerAdapter extends Context.Service<
  DockerAdapter,
  {
    readonly inventory: Effect.Effect<Inventory, DockerAdapterError>;
    readonly logs: (
      target: typeof ContainerTarget.Type,
      lines?: number,
    ) => Effect.Effect<typeof ContainerLogsResult.Type, ContainerError>;
  }
>()("t3/containers/DockerAdapter") {}

const Inspect = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.String,
  state: Schema.String,
  health: Schema.NullOr(Schema.String),
  restartCount: Schema.Number,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  composeProject: Schema.NullOr(Schema.String),
  composeService: Schema.NullOr(Schema.String),
  workingDirectory: Schema.NullOr(Schema.String),
  configFiles: Schema.NullOr(Schema.String),
  mounts: Schema.Array(Schema.Struct({ Type: Schema.String, Source: Schema.String })),
  ports: Schema.NullOr(
    Schema.Record(
      Schema.String,
      Schema.NullOr(
        Schema.Array(Schema.Struct({ HostIp: Schema.String, HostPort: Schema.String })),
      ),
    ),
  ),
});
// Keep this projection explicit: raw inspect includes environment variables and other credentials.
const INSPECT_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}},"restartCount":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDirectory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}';
const STATS_FORMAT =
  '{"id":{{json .Container}},"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}}}';
const decodeInspect = Schema.decodeUnknownOption(Schema.fromJsonString(Inspect));
const decodeStat = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.String, cpu: Schema.String, memory: Schema.String }),
  ),
);
const fullId = /^[a-f0-9]{64}$/;
const nullable = (value: string | null): string | null => value?.trim() || null;
const timestamp = (value: string | null): string | null =>
  value?.startsWith("0001-") ? null : nullable(value);

function unknownContainer(id: string): ContainerRecord {
  return {
    id,
    name: id.slice(0, 12),
    image: "",
    available: false,
    state: "unknown",
    health: null,
    restartCount: 0,
    startedAt: null,
    finishedAt: null,
    composeProject: null,
    composeService: null,
    composePaths: [],
    bindSources: [],
    ports: [],
    cpuPercent: null,
    memoryBytes: null,
    associations: [],
  };
}

function containerFromInspect(value: typeof Inspect.Type): ContainerRecord {
  const ports: ContainerRecord["ports"][number][] = [];
  for (const [key, bindings] of Object.entries(value.ports ?? {})) {
    const [port, protocol = "tcp"] = key.split("/");
    const containerPort = Number(port);
    for (const binding of bindings ?? []) {
      const hostPort = Number(binding.HostPort);
      if (
        Number.isInteger(containerPort) &&
        containerPort > 0 &&
        containerPort <= 65535 &&
        Number.isInteger(hostPort) &&
        hostPort > 0 &&
        hostPort <= 65535
      )
        ports.push({ containerPort, protocol, hostIp: binding.HostIp, hostPort });
    }
  }
  return {
    id: value.id,
    name: value.name.replace(/^\//, ""),
    image: value.image,
    available: true,
    state: value.state,
    health: nullable(value.health),
    restartCount: Math.max(0, Math.trunc(value.restartCount)),
    startedAt: timestamp(value.startedAt),
    finishedAt: timestamp(value.finishedAt),
    composeProject: nullable(value.composeProject),
    composeService: nullable(value.composeService),
    composePaths: [
      ...new Set(
        [value.workingDirectory, ...(value.configFiles?.split(",") ?? [])]
          .filter((path): path is string => Boolean(path?.trim()))
          .map((path) => path.trim()),
      ),
    ],
    composeConfigFiles:
      value.configFiles
        ?.split(",")
        .map((file) => file.trim())
        .filter(Boolean) ?? [],
    bindSources: value.mounts.filter((mount) => mount.Type === "bind").map((mount) => mount.Source),
    ports,
    cpuPercent: null,
    memoryBytes: null,
    associations: [],
  };
}

export const makeDockerAdapter = Effect.fn("DockerAdapter.make")(function* (options: {
  readonly platform: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly command?: string;
}) {
  const { select: engine, invoke } = yield* makeDockerConnection(options);

  const inventory = Effect.gen(function* () {
    const selected = yield* engine;
    const listed = yield* invoke(
      ["ps", "--all", "--no-trunc", "--format", "{{.ID}}"],
      selected.host,
      128 * 1024,
    );
    if (listed.code !== 0) return yield* new DockerAdapterError({ status: errorStatus(listed) });
    const lines = listed.stdout.split(/\r?\n/).filter(Boolean);
    const allIds = [...new Set(lines.filter((line) => fullId.test(line)))];
    const ids = allIds.slice(0, 1000);
    let complete =
      !listed.stdoutTruncated &&
      !listed.stdoutInvalidUtf8 &&
      lines.length === allIds.length &&
      allIds.length <= 1000;
    const containers = new Map<string, ContainerRecord>(
      ids.map((id) => [id, unknownContainer(id)]),
    );
    for (let offset = 0; offset < ids.length; offset += 40) {
      const result = yield* invoke(
        ["inspect", "--format", INSPECT_FORMAT, ...ids.slice(offset, offset + 40)],
        selected.host,
      ).pipe(Effect.option);
      if (Option.isNone(result)) {
        complete = false;
        continue;
      }
      if (result.value.code !== 0 || result.value.stdoutTruncated || result.value.stdoutInvalidUtf8)
        complete = false;
      for (const line of result.value.stdout.split(/\r?\n/).filter(Boolean)) {
        const parsed = decodeInspect(line);
        if (Option.isSome(parsed) && containers.has(parsed.value.id))
          containers.set(parsed.value.id, containerFromInspect(parsed.value));
        else complete = false;
      }
    }
    if (Array.from(containers.values()).some((container) => !container.available)) complete = false;
    const runningIds = Array.from(containers.values())
      .filter((container) => container.state === "running")
      .map((container) => container.id);
    let statsAvailable = true;
    for (let offset = 0; offset < runningIds.length; offset += 50) {
      const result = yield* invoke(
        [
          "stats",
          "--no-stream",
          "--no-trunc",
          "--format",
          STATS_FORMAT,
          ...runningIds.slice(offset, offset + 50),
        ],
        selected.host,
      ).pipe(Effect.option);
      if (Option.isNone(result) || result.value.code !== 0 || result.value.stdoutTruncated) {
        statsAvailable = false;
        continue;
      }
      for (const line of result.value.stdout.split(/\r?\n/).filter(Boolean)) {
        const parsed = decodeStat(line);
        if (Option.isNone(parsed)) {
          statsAvailable = false;
          continue;
        }
        const container = containers.get(parsed.value.id);
        if (!container) continue;
        const cpu = /^\d+(?:\.\d+)?%$/.test(parsed.value.cpu)
          ? Number(parsed.value.cpu.slice(0, -1))
          : null;
        containers.set(container.id, {
          ...container,
          cpuPercent: cpu,
          memoryBytes: parseDockerMemory(parsed.value.memory),
        });
      }
    }
    return {
      engineId: selected.id,
      engineName: selected.name,
      complete,
      containers: Array.from(containers.values()),
      message: !complete
        ? "Partial inventory: some containers could not be inspected or the collection limit was reached."
        : !statsAvailable
          ? "Container inventory is current; some resource measurements are unavailable."
          : "Docker inventory is current.",
    } satisfies Inventory;
  });

  return DockerAdapter.of({
    inventory,
    logs: Effect.fn("DockerAdapter.logs")(function* (target, lines = 200) {
      const selected = yield* engine.pipe(
        Effect.mapError(
          (error) =>
            new ContainerError({
              reason:
                error.status === "permission-denied"
                  ? "permission-denied"
                  : error.status === "unsupported"
                    ? "unsupported"
                    : "unavailable",
            }),
        ),
      );
      if (selected.id !== target.engineId)
        return yield* new ContainerError({ reason: "engine-changed" });
      const result = yield* invoke(
        [
          "logs",
          "--timestamps",
          "--tail",
          String(Math.min(1000, Math.max(1, Math.trunc(lines)))),
          target.containerId,
        ],
        selected.host,
        128 * 1024,
      ).pipe(Effect.mapError(() => new ContainerError({ reason: "unavailable" })));
      if (result.code !== 0)
        return yield* new ContainerError({
          reason: /no such container/i.test(result.stderr)
            ? "not-found"
            : /logging driver.*(support|read)/i.test(result.stderr)
              ? "unsupported"
              : errorStatus(result) === "permission-denied"
                ? "permission-denied"
                : "unavailable",
        });
      const text = NodeUtil.stripVTControlCharacters(
        [result.stdout, result.stderr ? `\n[stderr]\n${result.stderr}` : ""].join(""),
      );
      const bytes = Buffer.from(text);
      return {
        text: bytes.subarray(0, 256 * 1024).toString("utf8"),
        truncated: result.stdoutTruncated || result.stderrTruncated || bytes.length > 256 * 1024,
      };
    }),
  });
});

export const layer = Layer.effect(
  DockerAdapter,
  Effect.gen(function* () {
    return yield* makeDockerAdapter({
      platform: yield* HostProcess.Platform,
      environment: yield* HostProcess.Environment,
    });
  }),
);
