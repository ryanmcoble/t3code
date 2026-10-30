import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PROJECT_FOLDER_CHUNK_BYTES = 192 * 1024;

export const ProjectFolderEntry = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  kind: Schema.Literals(["file", "directory", "symlink"]),
  byteLength: NonNegativeInt,
  mode: NonNegativeInt,
  hash: Schema.optional(Schema.String),
  linkTarget: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type ProjectFolderEntry = typeof ProjectFolderEntry.Type;

export const ProjectFolderEntries = Schema.Array(ProjectFolderEntry);
export const ProjectFolderSessionInput = Schema.Struct({ transferId: TrimmedNonEmptyString });
export const ProjectFolderExportInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export const ProjectFolderExportResult = Schema.Struct({
  transferId: TrimmedNonEmptyString,
  entries: ProjectFolderEntries,
});
export const ProjectFolderImportInput = Schema.Struct({
  destinationPath: TrimmedNonEmptyString,
  entries: ProjectFolderEntries,
  previousEntries: Schema.optional(ProjectFolderEntries),
  incremental: Schema.optional(Schema.Boolean),
});
export const ProjectFolderImportResult = Schema.Struct({
  ...ProjectFolderSessionInput.fields,
  parallelChunks: Schema.optional(Schema.Boolean),
});
export const ProjectFolderReadInput = Schema.Struct({
  ...ProjectFolderSessionInput.fields,
  relativePath: TrimmedNonEmptyString,
  offset: NonNegativeInt,
});
export const ProjectFolderChunk = Schema.String.check(
  Schema.isMaxLength((PROJECT_FOLDER_CHUNK_BYTES / 3) * 4),
);
export const ProjectFolderReadResult = Schema.Struct({ contents: ProjectFolderChunk });
export const ProjectFolderWriteInput = Schema.Struct({
  ...ProjectFolderReadInput.fields,
  contents: ProjectFolderChunk,
});
export const ProjectFolderFinishResult = Schema.Struct({ cwd: TrimmedNonEmptyString });

export class ProjectFolderTransferError extends Schema.TaggedError<ProjectFolderTransferError>()(
  "ProjectFolderTransferError",
  {
    reason: Schema.Literals([
      "invalid_path",
      "unsupported_entry",
      "source_changed",
      "destination_exists",
      "invalid_session",
      "invalid_chunk",
      "incomplete",
      "io",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_path":
        return "A folder entry points outside the copied folder or has an unsupported name.";
      case "unsupported_entry":
        return "The folder contains a special file or a link outside the folder. Remove it before copying.";
      case "source_changed":
        return "The source folder changed during the copy. Stop work in it and try again.";
      case "destination_exists":
        return "The destination already exists. Choose a new folder.";
      case "invalid_session":
        return "The folder transfer expired or is no longer available. Try again.";
      case "invalid_chunk":
        return "The folder transfer received an invalid or overlapping chunk.";
      case "incomplete":
        return "The folder copy is incomplete. Try again.";
      case "io":
        return "The folder could not be copied. Check folder access and available disk space.";
    }
  }
}

export const ProjectFolderSyncState = Schema.Struct({
  peerEnvironmentId: EnvironmentId,
  peerPath: TrimmedNonEmptyString,
  baseline: ProjectFolderEntries,
  automatic: Schema.optionalKey(Schema.Boolean),
  coordinatorEnvironmentId: Schema.optionalKey(EnvironmentId),
});
export type ProjectFolderSyncState = typeof ProjectFolderSyncState.Type;
export const ProjectFolderSyncGetInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export const ProjectFolderSyncGetResult = Schema.NullOr(ProjectFolderSyncState);
export const ProjectFolderSyncSetInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  state: ProjectFolderSyncGetResult,
});

export const ProjectFolderExportEndInput = Schema.Struct({
  ...ProjectFolderSessionInput.fields,
  validate: Schema.Boolean,
});

export const ProjectFolderStatusResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  exists: Schema.Boolean,
  revision: Schema.String,
  sync: Schema.NullOr(
    Schema.Struct({
      peerEnvironmentId: EnvironmentId,
      peerPath: TrimmedNonEmptyString,
      automatic: Schema.optionalKey(Schema.Boolean),
      coordinatorEnvironmentId: Schema.optionalKey(EnvironmentId),
    }),
  ),
});
export type ProjectFolderStatusResult = typeof ProjectFolderStatusResult.Type;
