import { folderEntryEqual, planFolderSync } from "./projectFolderSync.ts";
import {
  PROJECT_FOLDER_CHUNK_BYTES,
  type EnvironmentId,
  type ProjectFolderSyncState,
  type ProjectFolderEntry,
} from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import type { createProjectEnvironmentAtoms } from "../state/projectCommands.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "../state/runtime.ts";
import { normalizeProjectPathForComparison } from "../state/projects.ts";

export { findFolderSyncProject } from "./projectFolderSync.ts";

type FolderCommandName =
  | "folderExport"
  | "folderExportEnd"
  | "folderImport"
  | "folderRead"
  | "folderWrite"
  | "folderFinish"
  | "folderCancel"
  | "folderSyncSet";
type FolderCommands<R, E> = {
  [K in FolderCommandName]: Pick<
    ReturnType<typeof createProjectEnvironmentAtoms<R, E>>[K],
    "run" | "label"
  >;
} & Pick<ReturnType<typeof createProjectEnvironmentAtoms<R, E>>, "folderSyncGet">;

async function transferFolderFiles<R, E>(
  registry: AtomRegistry.AtomRegistry,
  commands: FolderCommands<R, E>,
  files: Iterable<{
    readonly entry: ProjectFolderEntry;
    readonly environmentId: EnvironmentId;
    readonly transferId: string;
  }>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly transferId: string;
    readonly parallelChunks?: boolean | undefined;
  },
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: (bytes: number, path: string) => void;
  } = {},
) {
  function* chunks() {
    for (const file of files)
      for (let offset = 0; offset < file.entry.byteLength; offset += PROJECT_FOLDER_CHUNK_BYTES)
        yield { ...file, offset };
  }
  const pending = chunks();
  const commandOptions = { label: "Transfer folder files", reportFailure: false };
  let failure: { cause: unknown } | undefined;
  const worker = async () => {
    try {
      for (;;) {
        if (failure) return;
        options.signal?.throwIfAborted();
        const next = pending.next();
        if (next.done) return;
        const { entry, environmentId, transferId, offset } = next.value;
        const read = await runAtomCommand(
          registry,
          commands.folderRead,
          {
            environmentId,
            input: { transferId, relativePath: entry.path, offset },
          },
          commandOptions,
        );
        if (read._tag === "Failure") throw squashAtomCommandFailure(read);
        options.signal?.throwIfAborted();
        if (failure) return;
        const write = await runAtomCommand(
          registry,
          commands.folderWrite,
          {
            environmentId: target.environmentId,
            input: {
              transferId: target.transferId,
              relativePath: entry.path,
              offset,
              contents: read.value.contents,
            },
          },
          commandOptions,
        );
        if (write._tag === "Failure") throw squashAtomCommandFailure(write);
        options.onProgress?.(
          Math.min(PROJECT_FOLDER_CHUNK_BYTES, entry.byteLength - offset),
          entry.path,
        );
      }
    } catch (cause) {
      failure ??= { cause };
    }
  };
  // Bound queued payloads and drain requests before the caller removes transfer sessions.
  await Promise.all(Array.from({ length: target.parallelChunks ? 8 : 1 }, worker));
  if (failure) throw failure.cause;
}

export async function copyProjectFolder<R, E>(
  registry: AtomRegistry.AtomRegistry,
  commands: FolderCommands<R, E>,
  input: {
    readonly source: { readonly environmentId: EnvironmentId; readonly cwd: string };
    readonly targetEnvironmentId: EnvironmentId;
    readonly destinationPath: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (copied: number, total: number) => void;
  },
): Promise<string> {
  const options = { label: "Copy project folder", reportFailure: false };
  const checkCancelled = () => input.signal?.throwIfAborted();
  checkCancelled();
  const exported = await runAtomCommand(
    registry,
    commands.folderExport,
    {
      environmentId: input.source.environmentId,
      input: { cwd: input.source.cwd },
    },
    options,
  );
  if (exported._tag === "Failure") throw squashAtomCommandFailure(exported);
  let targetTransferId: string | null = null;
  try {
    checkCancelled();
    const imported = await runAtomCommand(
      registry,
      commands.folderImport,
      {
        environmentId: input.targetEnvironmentId,
        input: { destinationPath: input.destinationPath, entries: exported.value.entries },
      },
      options,
    );
    if (imported._tag === "Failure") throw squashAtomCommandFailure(imported);
    targetTransferId = imported.value.transferId;
    const total = exported.value.entries.reduce((sum, entry) => sum + entry.byteLength, 0);
    let copied = 0;
    input.onProgress?.(0, total);
    await transferFolderFiles(
      registry,
      commands,
      exported.value.entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => ({
          entry,
          environmentId: input.source.environmentId,
          transferId: exported.value.transferId,
        })),
      { environmentId: input.targetEnvironmentId, ...imported.value },
      {
        signal: input.signal,
        onProgress: (bytes) => {
          copied += bytes;
          input.onProgress?.(copied, total);
        },
      },
    );
    checkCancelled();
    const checked = await runAtomCommand(
      registry,
      commands.folderExportEnd,
      {
        environmentId: input.source.environmentId,
        input: { transferId: exported.value.transferId, validate: true },
      },
      options,
    );
    if (checked._tag === "Failure") throw squashAtomCommandFailure(checked);
    const finished = await runAtomCommand(
      registry,
      commands.folderFinish,
      {
        environmentId: input.targetEnvironmentId,
        input: { transferId: targetTransferId },
      },
      options,
    );
    if (finished._tag === "Failure") throw squashAtomCommandFailure(finished);
    targetTransferId = null;
    return finished.value.cwd;
  } finally {
    if (targetTransferId !== null)
      await runAtomCommand(
        registry,
        commands.folderCancel,
        {
          environmentId: input.targetEnvironmentId,
          input: { transferId: targetTransferId },
        },
        options,
      );
    await runAtomCommand(
      registry,
      commands.folderExportEnd,
      {
        environmentId: input.source.environmentId,
        input: { transferId: exported.value.transferId, validate: false },
      },
      options,
    );
  }
}

export async function linkProjectFolders<R, E>(
  registry: AtomRegistry.AtomRegistry,
  commands: FolderCommands<R, E>,
  local: { environmentId: EnvironmentId; cwd: string },
  remote: { environmentId: EnvironmentId; cwd: string },
) {
  const options = { label: "Link folder sync", reportFailure: false };
  for (const [folder, peer] of [
    [local, remote],
    [remote, local],
  ] as const) {
    const previous = await executeAtomQuery(
      registry,
      commands.folderSyncGet({ environmentId: folder.environmentId, input: { cwd: folder.cwd } }),
      { ...options, refresh: true },
    );
    if (previous._tag === "Failure") throw squashAtomCommandFailure(previous);
    if (
      previous.value !== null &&
      (previous.value.peerEnvironmentId !== peer.environmentId ||
        previous.value.peerPath !== peer.cwd)
    )
      throw new Error("One of these folders already has a sync partner. Unlink it first.");
  }
  const snapshot = await runAtomCommand(
    registry,
    commands.folderExport,
    { environmentId: remote.environmentId, input: { cwd: remote.cwd } },
    options,
  );
  if (snapshot._tag === "Failure") throw squashAtomCommandFailure(snapshot);
  try {
    for (const [folder, peer] of [
      [local, remote],
      [remote, local],
    ] as const) {
      const result = await runAtomCommand(
        registry,
        commands.folderSyncSet,
        {
          environmentId: folder.environmentId,
          input: {
            cwd: folder.cwd,
            state: {
              peerEnvironmentId: peer.environmentId,
              peerPath: peer.cwd,
              baseline: snapshot.value.entries,
            },
          },
        },
        options,
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      registry.refresh(
        commands.folderSyncGet({ environmentId: folder.environmentId, input: { cwd: folder.cwd } }),
      );
    }
  } finally {
    await runAtomCommand(
      registry,
      commands.folderExportEnd,
      {
        environmentId: remote.environmentId,
        input: { transferId: snapshot.value.transferId, validate: false },
      },
      options,
    );
  }
}

export async function copyOrSyncProjectFolder<R, E>(
  registry: AtomRegistry.AtomRegistry,
  commands: FolderCommands<R, E>,
  input: Parameters<typeof copyProjectFolder<R, E>>[2],
): Promise<{ cwd: string; reused: boolean }> {
  const result = await executeAtomQuery(
    registry,
    commands.folderSyncGet({
      environmentId: input.source.environmentId,
      input: { cwd: input.source.cwd },
    }),
    { label: "Check folder sync", reportFailure: false, refresh: true },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const state = result.value;
  if (
    state?.peerEnvironmentId === input.targetEnvironmentId &&
    normalizeProjectPathForComparison(state.peerPath) ===
      normalizeProjectPathForComparison(input.destinationPath)
  ) {
    input.signal?.throwIfAborted();
    await syncProjectFolder(registry, commands, input.source, state, undefined, input.signal);
    return { cwd: state.peerPath, reused: true };
  }
  return { cwd: await copyProjectFolder(registry, commands, input), reused: false };
}

export async function syncProjectFolder<R, E>(
  registry: AtomRegistry.AtomRegistry,
  commands: FolderCommands<R, E>,
  local: { environmentId: EnvironmentId; cwd: string },
  state: ProjectFolderSyncState,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const options = { label: "Sync folders", reportFailure: false };
  const localState = await executeAtomQuery(
    registry,
    commands.folderSyncGet({ environmentId: local.environmentId, input: { cwd: local.cwd } }),
    { ...options, refresh: true },
  );
  if (localState._tag === "Failure") throw squashAtomCommandFailure(localState);
  if (localState.value === null)
    throw new Error("Folder sync has been unlinked. Refresh and try again.");
  if (
    localState.value.peerEnvironmentId !== state.peerEnvironmentId ||
    localState.value.peerPath !== state.peerPath
  )
    throw new Error("This folder's sync partner changed. Refresh and try again.");
  state = localState.value;
  const remote = { environmentId: state.peerEnvironmentId, cwd: state.peerPath };
  const peerState = await executeAtomQuery(
    registry,
    commands.folderSyncGet({ environmentId: remote.environmentId, input: { cwd: remote.cwd } }),
    { ...options, refresh: true },
  );
  if (peerState._tag === "Failure") throw squashAtomCommandFailure(peerState);
  if (
    peerState.value === null ||
    peerState.value.peerEnvironmentId !== local.environmentId ||
    peerState.value.peerPath !== local.cwd
  )
    throw new Error("The other folder is no longer linked to this folder. No files were changed.");
  const peerBaseline = new Map(peerState.value.baseline.map((entry) => [entry.path, entry]));
  if (
    state.baseline.length !== peerBaseline.size ||
    state.baseline.some((entry) => !folderEntryEqual(entry, peerBaseline.get(entry.path)))
  )
    throw new Error(
      "The last sync did not finish saving its baseline on both machines. No files were changed. Unlink and copy again to establish a new baseline.",
    );
  const snapshots: Array<{
    environmentId: EnvironmentId;
    cwd: string;
    transferId: string;
    entries: readonly ProjectFolderEntry[];
  }> = [];
  const imports: Array<{ environmentId: EnvironmentId; transferId: string }> = [];
  try {
    onProgress?.("Comparing folders…");
    for (const folder of [local, remote]) {
      signal?.throwIfAborted();
      const result = await runAtomCommand(
        registry,
        commands.folderExport,
        { environmentId: folder.environmentId, input: { cwd: folder.cwd } },
        options,
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      snapshots.push({ ...folder, ...result.value });
    }
    const left = snapshots[0]!;
    const right = snapshots[1]!;
    const plan = planFolderSync(state.baseline, left.entries, right.entries);
    if (plan.conflicts.length)
      throw new Error(
        `Both folders changed these paths: ${plan.conflicts.slice(0, 10).join(", ")}${plan.conflicts.length > 10 ? ", …" : ""}. Resolve them on disk and sync again. Both versions have been kept.`,
      );
    const merged = plan.merged.map(({ entry }) => entry);
    for (const destination of snapshots) {
      const previous = new Map(destination.entries.map((entry) => [entry.path, entry]));
      if (
        destination.entries.length === merged.length &&
        merged.every((entry) => folderEntryEqual(entry, previous.get(entry.path)))
      )
        continue;
      const prepared = await runAtomCommand(
        registry,
        commands.folderImport,
        {
          environmentId: destination.environmentId,
          input: {
            destinationPath: destination.cwd,
            entries: merged,
            previousEntries: destination.entries,
          },
        },
        options,
      );
      if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
      const target = {
        environmentId: destination.environmentId,
        ...prepared.value,
      };
      imports.push(target);
      const files = plan.merged
        .filter(
          ({ entry }) =>
            !(
              entry.kind !== "file" ||
              (entry.hash &&
                previous.get(entry.path)?.kind === "file" &&
                previous.get(entry.path)?.hash === entry.hash)
            ),
        )
        .map(({ entry, source }) => {
          const origin = source === "local" ? left : right;
          return { entry, environmentId: origin.environmentId, transferId: origin.transferId };
        });
      await transferFolderFiles(registry, commands, files, target, {
        signal,
        onProgress: (_bytes, path) => onProgress?.(`Copying ${path}…`),
      });
    }
    for (const snapshot of snapshots) {
      const checked = await runAtomCommand(
        registry,
        commands.folderExportEnd,
        {
          environmentId: snapshot.environmentId,
          input: { transferId: snapshot.transferId, validate: true },
        },
        options,
      );
      if (checked._tag === "Failure") throw squashAtomCommandFailure(checked);
    }
    onProgress?.("Applying changes and deletions…");
    signal?.throwIfAborted();
    for (const target of imports) {
      const finished = await runAtomCommand(
        registry,
        commands.folderFinish,
        { environmentId: target.environmentId, input: { transferId: target.transferId } },
        options,
      );
      if (finished._tag === "Failure") throw squashAtomCommandFailure(finished);
    }
    for (const [folder, peer] of [
      [local, remote],
      [remote, local],
    ] as const) {
      const saved = await runAtomCommand(
        registry,
        commands.folderSyncSet,
        {
          environmentId: folder.environmentId,
          input: {
            cwd: folder.cwd,
            state: {
              peerEnvironmentId: peer.environmentId,
              peerPath: peer.cwd,
              baseline: merged,
            },
          },
        },
        options,
      );
      if (saved._tag === "Failure") throw squashAtomCommandFailure(saved);
    }
    onProgress?.("Folders are in sync.");
  } finally {
    for (const transfer of imports)
      await runAtomCommand(
        registry,
        commands.folderCancel,
        { environmentId: transfer.environmentId, input: { transferId: transfer.transferId } },
        options,
      );
    for (const snapshot of snapshots)
      await runAtomCommand(
        registry,
        commands.folderExportEnd,
        {
          environmentId: snapshot.environmentId,
          input: { transferId: snapshot.transferId, validate: false },
        },
        options,
      );
  }
}
