import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectFolderChunk, ProjectFolderEntries } from "./projectFolder.ts";
import { SharedProjectManifest, SharedProjectRoot } from "./sharedProject.ts";

export const SharedProjectContentPhase = Schema.Literals([
  "current",
  "local-changes",
  "conflict",
  "waiting",
  "error",
]);
export const SharedProjectContentTarget = Schema.Struct({
  sharedProjectId: SharedProjectManifest.fields.id,
  rootId: SharedProjectRoot.fields.id,
});
export const SharedProjectContentReceipt = Schema.Struct({
  ...SharedProjectContentTarget.fields,
  generation: PositiveInt,
  manifestRevision: PositiveInt,
  bindingRevision: PositiveInt,
  phase: SharedProjectContentPhase,
  sourceHash: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  conflictCount: NonNegativeInt,
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
});
export const SharedProjectContentStateInput = Schema.Struct({
  sharedProjectId: SharedProjectManifest.fields.id,
});
export const SharedProjectContentState = Schema.Struct({
  roots: Schema.Array(SharedProjectContentReceipt).check(Schema.isMaxLength(16)),
});
export const SharedProjectContentResolve = Schema.Struct({
  ...SharedProjectContentTarget.fields,
  expectedGeneration: PositiveInt,
  choice: Schema.Literals(["local", "owner"]),
});
export const SharedProjectContentCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("refresh"), ...SharedProjectContentTarget.fields }),
  Schema.Struct({ operation: Schema.Literal("resolve"), ...SharedProjectContentResolve.fields }),
]);
export const SharedProjectContentConflictInput = Schema.Struct({
  ...SharedProjectContentTarget.fields,
  cursor: NonNegativeInt,
});
export const SharedProjectContentConflictPage = Schema.Struct({
  generation: PositiveInt,
  paths: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(64),
  ),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});

const SessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const SharedProjectContentRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("observe"),
    rootId: SessionId,
    expectedManifestRevision: PositiveInt,
  }),
  Schema.Struct({
    operation: Schema.Literal("start"),
    rootId: SessionId,
    expectedManifestRevision: PositiveInt,
  }),
  Schema.Struct({
    operation: Schema.Literal("entries"),
    sessionId: SessionId,
    cursor: NonNegativeInt,
  }),
  Schema.Struct({
    operation: Schema.Literal("read"),
    sessionId: SessionId,
    relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    offset: NonNegativeInt,
  }),
  Schema.Struct({
    operation: Schema.Literal("end"),
    sessionId: SessionId,
    validate: Schema.Boolean,
  }),
]);
export const SharedProjectContentResponse = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("observation"),
    manifestRevision: PositiveInt,
    bindingRevision: PositiveInt,
    rootId: SessionId,
    observation: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    sessionId: SessionId,
    manifestRevision: PositiveInt,
    bindingRevision: PositiveInt,
    rootId: SessionId,
    observation: TrimmedNonEmptyString,
    hash: TrimmedNonEmptyString,
    entryCount: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("entries"),
    entries: ProjectFolderEntries.check(Schema.isMaxLength(256)),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
  Schema.Struct({ kind: Schema.Literal("chunk"), contents: ProjectFolderChunk }),
  Schema.Struct({ kind: Schema.Literal("ended") }),
]);
export class SharedProjectContentError extends Schema.TaggedError<SharedProjectContentError>()(
  "SharedProjectContentError",
  {
    origin: Schema.optionalKey(Schema.Literal("owner")),
    reason: Schema.Literals([
      "unmapped",
      "stale",
      "busy",
      "unsupported-root",
      "session",
      "quota",
      "transfer",
      "storage",
      "observation-limit",
      "activity-unavailable",
    ]),
  },
) {
  override get message(): string {
    return this.origin === "owner" ? `Project owner: ${this.description}` : this.description;
  }
  private get description(): string {
    switch (this.reason) {
      case "observation-limit":
        return "Too many shared folders are being watched. Pause unused shared projects and retry.";
      case "activity-unavailable":
        return "Project content is waiting because T3 could not verify workspace activity. Check machine access and retry.";
      case "unmapped":
        return "Review the project's local folder mappings and unpause preparation first.";
      case "stale":
        return "The project or its folders changed. Refresh before transferring content.";
      case "busy":
        return "Project content is waiting for active work or another transfer to finish.";
      case "unsupported-root":
        return "This root requires repository-aware transfer; ordinary folder copying is disabled.";
      case "session":
        return "The project transfer session expired or belongs to another recipient. Start a new snapshot.";
      case "quota":
        return "Project content reached a transfer or local storage limit. Review project size and retained content before retrying.";
      case "transfer":
        return "Project content changed or could not be transferred. Local files are preserved; retry after checking folder access.";
      case "storage":
        return "Project content data or its receipt could not be saved or read. Check local storage and folder access.";
    }
  }
}
