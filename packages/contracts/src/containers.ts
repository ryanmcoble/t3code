import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

export const ContainerId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ContainerAssociation = Schema.Struct({
  folder: TrimmedNonEmptyString,
  source: Schema.Literals(["manual", "compose", "mount"]),
  ruleId: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Literals(["container", "stack"])),
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
  composeConfigFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  stackKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
export const ContainerFolderRule = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  engineId: Schema.String,
  containerId: ContainerId,
  folder: Schema.String,
  rule: Schema.Literals(["include", "exclude"]),
  stackKey: Schema.NullOr(Schema.String),
});
export type ContainerFolderRule = typeof ContainerFolderRule.Type;
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
  folderAliases: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, canonicalPath: Schema.String })),
  ),
  associationRules: Schema.optionalKey(Schema.Array(ContainerFolderRule)),
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
  scope: Schema.optionalKey(Schema.Literals(["container", "stack"])),
  ruleId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16384))),
});
export class ContainerError extends Schema.TaggedError<ContainerError>()("ContainerError", {
  reason: Schema.Literals([
    "unavailable",
    "permission-denied",
    "unsupported",
    "not-found",
    "engine-changed",
    "storage",
    "unproven-stack",
    "ownership",
    "retained",
    "revision",
    "invalid-image",
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
      case "unproven-stack":
        return "This container does not identify a Compose project and configuration-file set. Link the individual container instead.";
      case "ownership":
        return "The container's durable ownership record and Docker labels do not match. No lifecycle action was performed.";
      case "retained":
        return "This resource is retained. Clear retention before releasing it.";
      case "revision":
        return "This resource changed. Refresh its status before continuing.";
      case "invalid-image":
        return "Choose a locally installed image by its full sha256 ID, without declared volumes. T3 does not pull images or adopt anonymous volumes.";
    }
  }
}

export const ManagedContainer = Schema.Struct({
  resourceId: TrimmedNonEmptyString,
  workspaceId: TrimmedNonEmptyString,
  threadId: ThreadId,
  engineId: TrimmedNonEmptyString,
  containerId: Schema.NullOr(ContainerId),
  name: TrimmedNonEmptyString,
  image: Schema.String,
  phase: Schema.Literals(["pending", "ready", "releasing", "failed", "released"]),
  generation: PositiveInt,
  retained: Schema.Boolean,
  references: Schema.Array(ThreadId),
  failure: Schema.NullOr(Schema.String),
});
export type ManagedContainer = typeof ManagedContainer.Type;
export const ManagedContainerInventory = Schema.Struct({
  items: Schema.Array(ManagedContainer),
  complete: Schema.Boolean,
});
export const ManagedContainerCreate = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  image: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  command: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(64),
  ),
  mountWorkspace: Schema.Boolean,
  ports: Schema.Array(PositiveInt.check(Schema.isLessThanOrEqualTo(65535))).check(
    Schema.isMaxLength(8),
  ),
});
export const ManagedContainerCommand = Schema.Struct({
  resourceId: TrimmedNonEmptyString,
  threadId: ThreadId,
  generation: PositiveInt,
  operation: Schema.Literals(["start", "stop", "release", "retry", "retain", "unretain", "share"]),
  referenceThreadId: Schema.optionalKey(ThreadId),
});
