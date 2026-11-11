import { ContainerError, type ManagedContainerCreate } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { makeDockerConnection } from "./DockerConnection.ts";

export interface ContainerOwnership {
  readonly engineId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly name: string;
}
export class ManagedContainerDriver extends Context.Service<
  ManagedContainerDriver,
  {
    readonly engineId: Effect.Effect<string, ContainerError>;
    readonly ensureCreated: (
      owner: ContainerOwnership,
      input: typeof ManagedContainerCreate.Type,
      root: string,
    ) => Effect.Effect<string, ContainerError>;
    readonly control: (
      owner: ContainerOwnership,
      containerId: string,
      operation: "start" | "stop" | "release",
    ) => Effect.Effect<void, ContainerError>;
  }
>()("t3/containers/ManagedContainerDriver") {}

const OWNER_FORMAT =
  '{"id":{{json .Id}},"workspace":{{json (index .Config.Labels "com.t3tools.workspace")}},"resource":{{json (index .Config.Labels "com.t3tools.resource")}},"state":{{json .State.Status}}}';
const decodeOwned = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      workspace: Schema.NullOr(Schema.String),
      resource: Schema.NullOr(Schema.String),
      state: Schema.String,
    }),
  ),
);
const decodeImage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      volumes: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const noSuchContainer = /no such (?:object|container)/i;

export const makeManagedContainerDriver = Effect.fn("ManagedContainerDriver.make")(
  function* (options: { readonly platform: string; readonly environment: NodeJS.ProcessEnv }) {
    const connection = yield* makeDockerConnection(options);
    const select = connection.select.pipe(
      Effect.mapError(
        (error) =>
          new ContainerError({
            reason:
              error.status === "unsupported"
                ? "unsupported"
                : error.status === "permission-denied"
                  ? "permission-denied"
                  : "unavailable",
          }),
      ),
    );
    const selectedFor = Effect.fn("ManagedContainerDriver.selectedFor")(function* (
      engineId: string,
    ) {
      const selected = yield* select;
      if (selected.id !== engineId) return yield* new ContainerError({ reason: "engine-changed" });
      return selected;
    });
    const invoke = (host: string, args: ReadonlyArray<string>) =>
      connection
        .invoke(args, host, 16384)
        .pipe(Effect.mapError(() => new ContainerError({ reason: "unavailable" })));
    const inspect = Effect.fn("ManagedContainerDriver.inspect")(function* (
      host: string,
      owner: ContainerOwnership,
      target: string,
    ) {
      const result = yield* invoke(host, [
        "inspect",
        "--type",
        "container",
        "--format",
        OWNER_FORMAT,
        target,
      ]);
      if (result.code !== 0) {
        if (noSuchContainer.test(result.stderr)) return null;
        return yield* new ContainerError({ reason: "unavailable" });
      }
      const parsed = decodeOwned(result.stdout.trim());
      if (
        result.stdoutTruncated ||
        Option.isNone(parsed) ||
        parsed.value.workspace !== owner.workspaceId ||
        parsed.value.resource !== owner.resourceId
      )
        return yield* new ContainerError({ reason: "ownership" });
      return parsed.value;
    });
    return ManagedContainerDriver.of({
      engineId: select.pipe(Effect.map((selected) => selected.id)),
      ensureCreated: Effect.fn("ManagedContainerDriver.ensureCreated")(
        function* (owner, input, root) {
          const selected = yield* selectedFor(owner.engineId);
          const existing = yield* inspect(selected.host, owner, owner.name);
          if (existing) return existing.id;
          const imageResult = yield* invoke(selected.host, [
            "image",
            "inspect",
            "--format",
            '{"id":{{json .Id}},"volumes":{{json .Config.Volumes}}}',
            input.image,
          ]);
          const image = decodeImage(imageResult.stdout.trim());
          if (
            imageResult.code !== 0 ||
            imageResult.stdoutTruncated ||
            Option.isNone(image) ||
            image.value.id !== input.image ||
            Object.keys(image.value.volumes ?? {}).length
          )
            return yield* new ContainerError({ reason: "invalid-image" });
          const args = [
            "create",
            "--pull",
            "never",
            "--name",
            owner.name,
            "--label",
            `com.t3tools.workspace=${owner.workspaceId}`,
            "--label",
            `com.t3tools.resource=${owner.resourceId}`,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--memory",
            "1g",
            "--cpus",
            "2",
            "--tmpfs",
            "/tmp:rw,nosuid,size=64m",
            "--network",
            input.ports.length ? "bridge" : "none",
          ];
          if (input.mountWorkspace)
            args.push(
              "--mount",
              `type=bind,source=${root},target=/workspace`,
              "--workdir",
              "/workspace",
            );
          for (const port of new Set(input.ports)) args.push("--publish", `127.0.0.1::${port}`);
          args.push(input.image, ...input.command);
          const result = yield* invoke(selected.host, args);
          // Inspect the deterministic name after a lost acknowledgement; never issue a second create blindly.
          const created = yield* inspect(selected.host, owner, owner.name);
          if (!created) return yield* new ContainerError({ reason: "unavailable" });
          if (result.code === 0 && result.stdout.trim() !== created.id)
            return yield* new ContainerError({ reason: "ownership" });
          return created.id;
        },
      ),
      control: Effect.fn("ManagedContainerDriver.control")(
        function* (owner, containerId, operation) {
          const selected = yield* selectedFor(owner.engineId);
          const container = yield* inspect(selected.host, owner, containerId);
          if (!container) {
            if (operation === "release") return;
            return yield* new ContainerError({ reason: "not-found" });
          }
          if (container.id !== containerId)
            return yield* new ContainerError({ reason: "ownership" });
          if (operation === "start" && container.state === "running") return;
          if (operation === "stop" && ["exited", "created", "dead"].includes(container.state))
            return;
          if (operation === "release" && !["exited", "created", "dead"].includes(container.state)) {
            const stopped = yield* invoke(selected.host, ["stop", "--timeout", "5", containerId]);
            if (stopped.code !== 0) return yield* new ContainerError({ reason: "unavailable" });
            const verified = yield* inspect(selected.host, owner, containerId);
            if (!verified) return;
            if (!["exited", "created", "dead"].includes(verified.state))
              return yield* new ContainerError({ reason: "unavailable" });
          }
          const args =
            operation === "stop"
              ? ["stop", "--timeout", "5", containerId]
              : [operation === "release" ? "rm" : "start", containerId];
          const result = yield* invoke(selected.host, args);
          if (result.code !== 0) return yield* new ContainerError({ reason: "unavailable" });
        },
      ),
    });
  },
);

export const layer = Layer.effect(
  ManagedContainerDriver,
  Effect.gen(function* () {
    return yield* makeManagedContainerDriver({
      platform: yield* HostProcess.Platform,
      environment: yield* HostProcess.Environment,
    });
  }),
);
