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
    for (const entry of exported.value.entries) {
      if (entry.kind !== "file") continue;
      for (let offset = 0; offset < entry.byteLength; offset += PROJECT_FOLDER_CHUNK_BYTES) {
        checkCancelled();
        const read = await runAtomCommand(
          registry,
          commands.folderRead,
          {
            environmentId: input.source.environmentId,
            input: { transferId: exported.value.transferId, relativePath: entry.path, offset },
          },
          options,
        );
        if (read._tag === "Failure") throw squashAtomCommandFailure(read);
        checkCancelled();
        const written = await runAtomCommand(
          registry,
          commands.folderWrite,
          {
            environmentId: input.targetEnvironmentId,
            input: {
              transferId: targetTransferId,
              relativePath: entry.path,
              offset,
              contents: read.value.contents,
            },
          },
          options,
        );
        if (written._tag === "Failure") throw squashAtomCommandFailure(written);
        copied += Math.min(PROJECT_FOLDER_CHUNK_BYTES, entry.byteLength - offset);
        input.onProgress?.(copied, total);
      }
    }
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

export async function syncProjectFolder<R, E>(
  registry: AtomRegistry.AtomRegistry,
  commands: FolderCommands<R, E>,
  local: { environmentId: EnvironmentId; cwd: string },
  state: ProjectFolderSyncState,
  onProgress?: (message: string) => void,
): Promise<void> {
  const options = { label: "Sync folders", reportFailure: false };
  const localState = await executeAtomQuery(
    registry,
    commands.folderSyncGet({ environmentId: local.environmentId, input: { cwd: local.cwd } }),
    { ...options, refresh: true },
  );
  if (localState._tag === "Failure") throw squashAtomCommandFailure(localState);
  if (localState.value === null)
    throw new Error("Folder sync has been unlinked. Refresh and try again.");
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
        transferId: prepared.value.transferId,
      };
      imports.push(target);
      for (const { entry, source } of plan.merged) {
        if (
          entry.kind !== "file" ||
          (entry.hash &&
            previous.get(entry.path)?.kind === "file" &&
            previous.get(entry.path)?.hash === entry.hash)
        )
          continue;
        onProgress?.(`Copying ${entry.path}…`);
        const origin = source === "local" ? left : right;
        for (let offset = 0; offset < entry.byteLength; offset += PROJECT_FOLDER_CHUNK_BYTES) {
          const read = await runAtomCommand(
            registry,
            commands.folderRead,
            {
              environmentId: origin.environmentId,
              input: { transferId: origin.transferId, relativePath: entry.path, offset },
            },
            options,
          );
          if (read._tag === "Failure") throw squashAtomCommandFailure(read);
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
            options,
          );
          if (write._tag === "Failure") throw squashAtomCommandFailure(write);
        }
      }
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
