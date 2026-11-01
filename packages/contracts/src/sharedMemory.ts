import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Id = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_.:-]+$/),
);
const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const MemoryAccess = Schema.Literals(["read", "write"]);
export const MemoryScopeReference = Schema.Struct({
  scopeId: Id,
  name: Name,
  ownerEnvironmentId: EnvironmentId,
  sourceUrl: Schema.String.check(
    Schema.isPattern(
      /^(https:\/\/[^\s/@?#]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?)\/?$/,
    ),
  ),
  access: MemoryAccess,
});
export const MemoryScope = Schema.Struct({
  id: Id,
  name: Name,
  kind: Schema.Literals(["personal", "company", "project"]),
  projectIds: Schema.Array(ProjectId),
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  writableProviderInstanceIds: Schema.Array(ProviderInstanceId),
  revision: Schema.Int,
  createdAt: Schema.String,
});
export type MemoryScope = typeof MemoryScope.Type;
export const MemorySource = Schema.Struct({
  reference: Schema.String.check(Schema.isMaxLength(2000)),
  threadId: Schema.optionalKey(ThreadId),
});
export const MemoryAuthor = Schema.Struct({
  environmentId: EnvironmentId,
  kind: Schema.Literals(["user", "agent"]),
  threadId: Schema.optionalKey(ThreadId),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export const MemoryEntry = Schema.Struct({
  id: Id,
  scopeId: Id,
  kind: Schema.Literals(["decision", "preference", "finding"]),
  title: Name,
  content: Schema.String.check(Schema.isMaxLength(16000)),
  source: MemorySource,
  author: MemoryAuthor,
  createdAt: Schema.String,
  supersedes: Schema.NullOr(Id),
  supersededBy: Schema.NullOr(Id),
  deleted: Schema.Boolean,
});
export type MemoryEntry = typeof MemoryEntry.Type;
export const MemoryQuery = Schema.Struct({
  scopeId: Id,
  query: Schema.String.check(Schema.isMaxLength(1000)),
  tokenBudget: Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 8192 })),
});
export const MemoryQueryResult = Schema.Struct({
  entries: Schema.Array(MemoryEntry),
  estimatedTokens: Schema.Int,
  truncated: Schema.Boolean,
  contextKind: Schema.Literal("evidence"),
});
export const MemoryWrite = Schema.Struct({
  scopeId: Id,
  id: Id,
  kind: MemoryEntry.fields.kind,
  title: Name,
  content: MemoryEntry.fields.content,
  source: MemorySource,
  supersedes: Schema.optionalKey(Id),
});
export const MemoryRemoteBinding = Schema.Struct({
  scopeId: Id,
  name: Name,
  ownerEnvironmentId: EnvironmentId,
  sourceUrl: Schema.String,
  projectIds: Schema.Array(ProjectId),
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  access: MemoryAccess,
});
export type MemoryRemoteBinding = typeof MemoryRemoteBinding.Type;
export const MemoryGrantSummary = Schema.Struct({
  scopeId: Id,
  destinationEnvironmentId: EnvironmentId,
  access: MemoryAccess,
});
export const MemoryState = Schema.Struct({
  scopes: Schema.Array(MemoryScope),
  bindings: Schema.Array(MemoryRemoteBinding),
  profileScopes: Schema.Array(MemoryScopeReference),
  grants: Schema.Array(MemoryGrantSummary),
});
export const MemoryGrantInput = Schema.Struct({
  scopeId: Id,
  destinationEnvironmentId: EnvironmentId,
  access: MemoryAccess,
  revoke: Schema.Boolean,
});
export const MemoryGrantResult = Schema.Struct({ token: Schema.NullOr(Schema.String) });
export const MemoryCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("scope-save"),
    scope: MemoryScope,
    expectedRevision: Schema.Int,
  }),
  Schema.Struct({
    operation: Schema.Literal("scope-delete"),
    scopeId: Id,
    expectedRevision: Schema.Int,
  }),
  Schema.Struct({ operation: Schema.Literal("write"), entry: MemoryWrite }),
  Schema.Struct({ operation: Schema.Literal("delete"), scopeId: Id, entryId: Id }),
  Schema.Struct({
    operation: Schema.Literal("connect"),
    binding: MemoryRemoteBinding,
    token: Schema.String,
  }),
  Schema.Struct({ operation: Schema.Literal("disconnect"), scopeId: Id }),
]);
export const MemoryExport = Schema.Struct({
  scope: MemoryScope,
  entries: Schema.Array(MemoryEntry),
});
export class SharedMemoryError extends Schema.TaggedError<SharedMemoryError>()(
  "SharedMemoryError",
  {
    reason: Schema.Literals([
      "denied",
      "not-found",
      "conflict",
      "unavailable",
      "invalid",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "denied":
        return "This caller cannot access this memory scope.";
      case "not-found":
        return "The memory scope or entry was not found.";
      case "conflict":
        return "Memory changed. Refresh before saving this correction.";
      case "unavailable":
        return "The memory owner is unavailable. No cached finding was substituted.";
      case "invalid":
        return "The memory request is invalid.";
      case "storage":
        return "Memory could not be saved or read.";
    }
  }
}
