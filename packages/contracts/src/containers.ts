import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

export const ContainerId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ContainerAssociation = Schema.Struct({
  folder: TrimmedNonEmptyString,
  source: Schema.Literals(["manual", "compose", "mount"]),
});
export type ContainerAssociation = typeof ContainerAssociation.Type;
export const ContainerPort = Schema.Struct({
  containerPort: PositiveInt,
  protocol: Schema.String,
  hostIp: Schema.String,
  hostPort: PositiveInt,
});
export const ContainerRecord = Schema.Struct({
  id: ContainerId,
  name: Schema.String,
  image: Schema.String,
  available: Schema.Boolean,
  state: Schema.String,
  health: Schema.NullOr(Schema.String),
  restartCount: NonNegativeInt,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  composeProject: Schema.NullOr(Schema.String),
  composeService: Schema.NullOr(Schema.String),
  composePaths: Schema.Array(Schema.String),
  bindSources: Schema.Array(Schema.String),
  ports: Schema.Array(ContainerPort),
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.NullOr(Schema.Number),
  associations: Schema.Array(ContainerAssociation),
});
export type ContainerRecord = typeof ContainerRecord.Type;
export const ContainerCounts = Schema.Struct({
  total: NonNegativeInt,
  running: NonNegativeInt,
  stopped: NonNegativeInt,
  paused: NonNegativeInt,
  restarting: NonNegativeInt,
  removing: NonNegativeInt,
  unknown: NonNegativeInt,
  unhealthy: NonNegativeInt,
});
export type ContainerCounts = typeof ContainerCounts.Type;
export const ContainerSnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  engineId: Schema.NullOr(Schema.String),
  engineName: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "starting",
    "ready",
    "partial",
    "cli-missing",
    "engine-unavailable",
    "permission-denied",
    "unsupported",
  ]),
  message: Schema.String,
  complete: Schema.Boolean,
  stale: Schema.Boolean,
  containers: Schema.Array(ContainerRecord),
  counts: ContainerCounts,
});
export type ContainerSnapshot = typeof ContainerSnapshot.Type;
export const ContainerTarget = Schema.Struct({
  engineId: TrimmedNonEmptyString,
  containerId: ContainerId,
});
export const ContainerLogsInput = Schema.Struct({
  ...ContainerTarget.fields,
  lines: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(1000))),
});
export const ContainerLogsResult = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
});
export const ContainerAssociationCommand = Schema.Struct({
  ...ContainerTarget.fields,
  folder: TrimmedNonEmptyString,
  operation: Schema.Literals(["include", "exclude", "remove"]),
});
export class ContainerError extends Schema.TaggedError<ContainerError>()("ContainerError", {
  reason: Schema.Literals([
    "unavailable",
    "permission-denied",
    "unsupported",
    "not-found",
    "engine-changed",
    "storage",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Docker could not complete this request on this environment.";
      case "permission-denied":
        return "The environment service cannot access the Docker engine.";
      case "unsupported":
        return "This Docker engine or logging driver is not supported.";
      case "not-found":
        return "This container is no longer available. Refresh the inventory.";
      case "engine-changed":
        return "The selected Docker engine changed. Refresh before continuing.";
      case "storage":
        return "Container associations could not be saved or read.";
    }
  }
}
