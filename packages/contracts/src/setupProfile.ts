import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { MemoryScopeReference } from "./sharedMemory.ts";
import { ComputerUseProfilePolicy } from "./computerUse.ts";

const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const SecretName = Name.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SetupValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("literal"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("secret"), name: SecretName }),
]);
export type SetupValue = typeof SetupValue.Type;

export const SetupMcpConnection = Schema.Struct({
  name: Name,
  transport: Schema.Literals(["stdio", "http"]),
  command: Schema.optional(Schema.String),
  args: Schema.Array(Schema.String),
  url: Schema.optional(Schema.String),
  environment: Schema.Record(Schema.String, SetupValue),
  headers: Schema.Record(Schema.String, SetupValue),
  drivers: Schema.Array(Name),
  enabled: Schema.Boolean,
});
export type SetupMcpConnection = typeof SetupMcpConnection.Type;

export const SetupSkillFile = Schema.Struct({
  path: Schema.String,
  digest: Digest,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  executable: Schema.Boolean,
});
export const SetupSkill = Schema.Struct({
  name: Name,
  files: Schema.Array(SetupSkillFile),
  drivers: Schema.Array(Name),
});
export type SetupSkill = typeof SetupSkill.Type;

export const SetupProfile = Schema.Struct({
  id: Name,
  ownerEnvironmentId: EnvironmentId,
  name: Name,
  revision: Revision,
  schemaVersion: Schema.Literal(1),
  connections: Schema.Array(SetupMcpConnection),
  skills: Schema.Array(SetupSkill),
  memoryScopes: Schema.optionalKey(Schema.Array(MemoryScopeReference)),
  computerUse: Schema.optionalKey(ComputerUseProfilePolicy),
});
export type SetupProfile = typeof SetupProfile.Type;

export const SetupItemStatus = Schema.Struct({
  name: Schema.String,
  instanceId: ProviderInstanceId,
  kind: Schema.Literals(["mcp", "skill"]),
  status: Schema.Literals([
    "configured",
    "verified",
    "conflict",
    "needs-secret",
    "missing-prerequisite",
    "unsupported",
    "waiting",
    "overridden",
    "failed",
  ]),
  message: Schema.String,
});
export type SetupItemStatus = typeof SetupItemStatus.Type;

export const SetupProfileBinding = Schema.Struct({
  profile: SetupProfile,
  sourceUrl: Schema.NullOr(Schema.String),
  instanceIds: Schema.Array(ProviderInstanceId),
  enabled: Schema.Boolean,
  observedRevision: Revision,
  appliedRevision: Revision,
  items: Schema.Array(SetupItemStatus),
  error: Schema.NullOr(Schema.String),
  lastApplied: Schema.optional(
    Schema.Struct({
      profileId: Name,
      revision: Revision,
      instanceIds: Schema.Array(ProviderInstanceId),
      detached: Schema.Boolean,
    }),
  ),
  detached: Schema.optional(Schema.Boolean),
  pendingRemoval: Schema.optional(Schema.Boolean),
  conflicts: Schema.optional(Schema.Array(Schema.String)),
});
export type SetupProfileBinding = typeof SetupProfileBinding.Type;

export const SetupProfileState = Schema.Struct({
  profiles: Schema.Array(SetupProfile),
  binding: Schema.NullOr(SetupProfileBinding),
});
export type SetupProfileState = typeof SetupProfileState.Type;

export const SetupProfilePublishInput = Schema.Struct({
  id: Schema.optional(Name),
  name: Name,
  expectedRevision: Revision,
  connections: Schema.Array(SetupMcpConnection),
  skills: Schema.Array(SetupSkill),
  memoryScopes: Schema.optionalKey(Schema.Array(MemoryScopeReference)),
  computerUse: Schema.optionalKey(ComputerUseProfilePolicy),
});
export type SetupProfilePublishInput = typeof SetupProfilePublishInput.Type;

export const SetupProfileCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("publish"), profile: SetupProfilePublishInput }),
  Schema.Struct({
    operation: Schema.Literal("apply"),
    profileId: Name,
    instanceIds: Schema.Array(ProviderInstanceId),
    subscribe: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("subscribe"),
    profileId: Name,
    ownerEnvironmentId: EnvironmentId,
    sourceUrl: Schema.String,
    token: Schema.String,
    instanceIds: Schema.Array(ProviderInstanceId),
  }),
  Schema.Struct({ operation: Schema.Literal("pause"), paused: Schema.Boolean }),
  Schema.Struct({ operation: Schema.Literal("reconcile") }),
  Schema.Struct({
    operation: Schema.Literal("bind-secret"),
    name: SecretName,
    secret: Schema.String.check(Schema.isMaxLength(65_536)),
  }),
  Schema.Struct({ operation: Schema.Literal("detach"), removeManaged: Schema.Boolean }),
  Schema.Struct({
    operation: Schema.Literal("resolve"),
    path: Schema.String,
    resolution: Schema.Literals(["keep-local", "use-profile"]),
  }),
]);
export type SetupProfileCommand = typeof SetupProfileCommand.Type;

export const SetupProfileImportInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  skillPaths: Schema.Array(Schema.String),
});
export const SetupProfileImportResult = Schema.Struct({
  connections: Schema.Array(SetupMcpConnection),
  skills: Schema.Array(SetupSkill),
  warnings: Schema.Array(Schema.String),
});
export type SetupProfileImportResult = typeof SetupProfileImportResult.Type;

export const SetupProfileGrantInput = Schema.Struct({
  profileId: Name,
  destinationEnvironmentId: EnvironmentId,
  revoke: Schema.Boolean,
});
export const SetupProfileGrantResult = Schema.Struct({ token: Schema.NullOr(Schema.String) });

export class SetupProfileError extends Schema.TaggedError<SetupProfileError>()(
  "SetupProfileError",
  {
    reason: Schema.Literals([
      "storage",
      "conflict",
      "invalid",
      "not-found",
      "denied",
      "unreachable",
      "unsupported",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "storage":
        return "The setup profile could not be read or saved.";
      case "conflict":
        return "This setup changed. Refresh it before trying again.";
      case "invalid":
        return "The setup profile contains an invalid path, connection, or package.";
      case "not-found":
        return "The setup profile or provider instance was not found.";
      case "denied":
        return "This setup subscription is not authorized.";
      case "unreachable":
        return "The profile owner is unreachable. The last working setup is retained.";
      case "unsupported":
        return "This setup requires a newer server or a supported provider configuration.";
    }
  }
}

export const SetupProfileReadiness = Schema.NullOr(
  Schema.Struct({
    profileId: Schema.String,
    name: Schema.String,
    ownerEnvironmentId: EnvironmentId,
    appliedRevision: Revision,
    observedRevision: Revision,
    syncing: Schema.Boolean,
    items: Schema.Array(SetupItemStatus),
    error: Schema.NullOr(Schema.String),
  }),
);

export function setupProfileReadiness(
  binding: SetupProfileBinding | null,
): typeof SetupProfileReadiness.Type {
  return binding === null
    ? null
    : {
        profileId: binding.profile.id,
        name: binding.profile.name,
        ownerEnvironmentId: binding.profile.ownerEnvironmentId,
        appliedRevision: binding.appliedRevision,
        observedRevision: binding.observedRevision,
        syncing: binding.enabled && !binding.detached,
        items: binding.items,
        error: binding.error,
      };
}
