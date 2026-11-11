import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProjectId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectFolderContentPolicy } from "./projectFolder.ts";

const Identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_.-]+$/),
);
export const SharedProjectRoot = Schema.Struct({
  id: Identifier,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  kind: Schema.Literals(["git", "files"]),
  repositoryKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  contentPolicy: ProjectFolderContentPolicy,
});
export const SharedProjectManifest = Schema.Struct({
  id: Identifier,
  ownerEnvironmentId: EnvironmentId,
  revision: PositiveInt,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  roots: Schema.Array(SharedProjectRoot).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  members: Schema.Array(EnvironmentId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  setupProfileId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  archived: Schema.Boolean,
});
export type SharedProjectManifest = typeof SharedProjectManifest.Type;
export const SharedProjectRootBinding = Schema.Struct({
  rootId: Identifier,
  projectId: ProjectId,
  path: TrimmedNonEmptyString,
});
export const SharedProjectBinding = Schema.Struct({
  sharedProjectId: Identifier,
  environmentId: EnvironmentId,
  manifestRevision: PositiveInt,
  revision: PositiveInt,
  detached: Schema.Boolean,
  roots: Schema.Array(SharedProjectRootBinding),
  paused: Schema.Boolean,
});
export type SharedProjectBinding = typeof SharedProjectBinding.Type;
export const SharedProjectState = Schema.Struct({
  projects: Schema.Array(SharedProjectManifest),
  bindings: Schema.Array(SharedProjectBinding),
  complete: Schema.Boolean,
});
export type SharedProjectState = typeof SharedProjectState.Type;
export const SharedProjectSubscription = Schema.Struct({
  sharedProjectId: Identifier,
  ownerEnvironmentId: EnvironmentId,
  sourceUrl: TrimmedNonEmptyString,
  paused: Schema.Boolean,
  observedRevision: NonNegativeInt,
  lastCheckedAt: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(Schema.String),
});
export type SharedProjectSubscription = typeof SharedProjectSubscription.Type;
export const SharedProjectEnrollmentState = Schema.Struct({
  subscriptions: Schema.Array(SharedProjectSubscription),
  complete: Schema.Boolean,
});
export const SharedProjectGrantInput = Schema.Struct({
  sharedProjectId: Identifier,
  destinationEnvironmentId: EnvironmentId,
  revoke: Schema.Boolean,
  access: Schema.optionalKey(Schema.Literals(["metadata", "files", "repository-history"])),
});
export const SharedProjectGrantResult = Schema.Struct({ token: Schema.NullOr(Schema.String) });
export const SharedProjectSubscriptionControl = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("pause"),
    sharedProjectId: Identifier,
    paused: Schema.Boolean,
  }),
  Schema.Struct({ operation: Schema.Literal("disconnect"), sharedProjectId: Identifier }),
  Schema.Struct({ operation: Schema.Literal("refresh"), sharedProjectId: Identifier }),
]);
export const SharedProjectEnrollmentCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("connect"),
    sharedProjectId: Identifier,
    ownerEnvironmentId: EnvironmentId,
    sourceUrl: TrimmedNonEmptyString,
    token: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
  SharedProjectSubscriptionControl,
]);
export const SharedProjectPublish = Schema.Struct({
  id: Schema.optionalKey(Identifier),
  expectedRevision: NonNegativeInt,
  name: SharedProjectManifest.fields.name,
  roots: SharedProjectManifest.fields.roots,
  members: SharedProjectManifest.fields.members,
  setupProfileId: SharedProjectManifest.fields.setupProfileId,
  archived: Schema.Boolean,
});
export const SharedProjectBind = Schema.Struct({
  sharedProjectId: Identifier,
  expectedRevision: PositiveInt,
  expectedBindingRevision: NonNegativeInt,
  roots: Schema.Array(Schema.Struct({ rootId: Identifier, projectId: ProjectId })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  paused: Schema.Boolean,
});
export const SharedProjectCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("publish"), manifest: SharedProjectPublish }),
  Schema.Struct({ operation: Schema.Literal("bind"), binding: SharedProjectBind }),
  Schema.Struct({
    operation: Schema.Literal("unbind"),
    sharedProjectId: Identifier,
    expectedBindingRevision: PositiveInt,
  }),
]);
export class SharedProjectError extends Schema.TaggedError<SharedProjectError>()(
  "SharedProjectError",
  {
    reason: Schema.Literals([
      "not-found",
      "revision",
      "owner",
      "membership",
      "invalid-manifest",
      "invalid-root",
      "root-kind",
      "storage",
      "denied",
      "unreachable",
      "unsupported",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "denied":
        return "This project subscription is not authorized. Check membership and renew its grant on the owner.";
      case "unreachable":
        return "The project owner could not be reached. Cached folders remain local; preparation is waiting.";
      case "unsupported":
        return "Update the project owner to a version that supports shared project enrollment.";
      case "not-found":
        return "This shared project is unavailable.";
      case "revision":
        return "The shared project changed. Refresh before continuing.";
      case "owner":
        return "Only the nominated owner environment may publish this shared project.";
      case "membership":
        return "This environment is not a selected member of the shared project.";
      case "invalid-manifest":
        return "Choose unique roots and members, include the owner, and use literal relative exclusion paths.";
      case "invalid-root":
        return "Each root must map to a distinct registered project folder with local access.";
      case "root-kind":
        return "The selected folder does not match this root's repository type or identity.";
      case "storage":
        return "Shared project metadata could not be saved or read.";
    }
  }
}
