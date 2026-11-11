import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectFolderChunk, ProjectFolderEntries } from "./projectFolder.ts";

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
