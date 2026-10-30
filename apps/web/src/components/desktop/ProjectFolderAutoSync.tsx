import {
  createFolderSyncMonitor,
  syncProjectFolder,
} from "@t3tools/client-runtime/operations/project-folder";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { normalizeProjectPathForComparison } from "@t3tools/client-runtime/state/projects";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthFilesystemReadScope, AuthFilesystemWriteScope } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShells, useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { folderSyncMessageKey, folderSyncMessagesAtom } from "../../state/projectFolderAutoSync";
import { toastManager } from "../ui/toast";

function containsFolder(parent: string, child: string) {
  const root = normalizeProjectPathForComparison(parent);
  const path = normalizeProjectPathForComparison(child);
  return path === root || path.startsWith(`${root}/`);
}

function FolderSyncWorker({
  project,
  projects,
}: {
  readonly project: EnvironmentProject;
  readonly projects: readonly EnvironmentProject[];
}) {
  const query = projectEnvironment.folderSyncGet({
    environmentId: project.environmentId,
    input: { cwd: project.workspaceRoot },
  });
  const { data: pair } = useEnvironmentQuery(query);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const automatic =
    pair?.automatic === true && pair.coordinatorEnvironmentId === primaryEnvironmentId;
  const peerEnvironmentId = pair?.peerEnvironmentId;
  const peerPath = pair?.peerPath;
  const report = useEffectEvent((message: string, failed = false) => {
    const key = folderSyncMessageKey(project.environmentId, project.workspaceRoot);
    const current = appAtomRegistry.get(folderSyncMessagesAtom);
    if (current.get(key) === message) return;
    appAtomRegistry.set(folderSyncMessagesAtom, new Map(current).set(key, message));
    if (failed)
      toastManager.add({ type: "warning", title: "Folder sync paused", description: message });
  });
  const busy = useEffectEvent(() =>
    readThreadShells().some((thread) => {
      if (!thread.runtime?.activeRunId) return false;
      const root = projects.find(
        (candidate) =>
          candidate.id === thread.projectId && candidate.environmentId === thread.environmentId,
      )?.workspaceRoot;
      if (!root) return false;
      return (
        (thread.environmentId === project.environmentId &&
          containsFolder(project.workspaceRoot, root)) ||
        (thread.environmentId === peerEnvironmentId &&
          peerPath !== undefined &&
          containsFolder(peerPath, root))
      );
    }),
  );
  const synchronize = useEffectEvent(async (signal: AbortSignal) => {
    // The workflow itself reloads both baselines and rejects an unlink before touching files.
    if (!pair) return;
    await syncProjectFolder(
      appAtomRegistry,
      projectEnvironment,
      { environmentId: project.environmentId, cwd: project.workspaceRoot },
      pair,
      undefined,
      signal,
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coordinates the persisted folder link with both servers while this desktop renderer is alive, including when its window is hidden
  useEffect(() => {
    if (!automatic || peerEnvironmentId === undefined || peerPath === undefined) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const monitor = createFolderSyncMonitor({
      synchronize: () => synchronize(controller.signal),
      report,
    });
    const tick = async () => {
      try {
        const statuses = await Promise.all(
          [
            { environmentId: project.environmentId, cwd: project.workspaceRoot },
            { environmentId: peerEnvironmentId, cwd: peerPath },
          ].map(async (folder) => {
            const result = await runAtomCommand(
              appAtomRegistry,
              projectEnvironment.folderStatus,
              { environmentId: folder.environmentId, input: { cwd: folder.cwd } },
              { label: "Check folder changes", reportFailure: false },
            );
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          }),
        );
        if (controller.signal.aborted) return;
        const [left, right] = statuses;
        const linked =
          left!.sync?.automatic &&
          right!.sync?.automatic &&
          left!.sync.peerEnvironmentId === peerEnvironmentId &&
          right!.sync.peerEnvironmentId === project.environmentId &&
          normalizeProjectPathForComparison(peerPath) ===
            normalizeProjectPathForComparison(left!.sync.peerPath) &&
          normalizeProjectPathForComparison(project.workspaceRoot) ===
            normalizeProjectPathForComparison(right!.sync.peerPath) &&
          left!.sync.coordinatorEnvironmentId === primaryEnvironmentId &&
          right!.sync.coordinatorEnvironmentId === primaryEnvironmentId;
        if (!linked) {
          appAtomRegistry.refresh(query);
          monitor.reset();
          return;
        }
        const permitted = [project.environmentId, peerEnvironmentId].every(
          (id) =>
            readEnvironmentScope(id, AuthFilesystemReadScope) &&
            readEnvironmentScope(id, AuthFilesystemWriteScope),
        );
        await monitor.observe({
          revision: JSON.stringify(statuses.map((status) => status.revision)),
          ready: Boolean(left!.exists && right!.exists && permitted),
          busy: busy(),
          now: Date.now(),
        });
      } catch {
        if (!controller.signal.aborted) {
          monitor.reset();
          report("Waiting for both machines…");
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void tick(), 1500);
      }
    };
    void tick();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    automatic,
    peerEnvironmentId,
    peerPath,
    project.environmentId,
    project.workspaceRoot,
    primaryEnvironmentId,
    query,
  ]);
  return null;
}

export function ProjectFolderAutoSync() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return projects
    .filter(
      (project) =>
        project.environmentId === primaryEnvironmentId &&
        !project.repositoryIdentity?.locator.remoteUrl,
    )
    .map((project) => (
      <FolderSyncWorker
        key={`${project.environmentId}:${project.id}`}
        project={project}
        projects={projects}
      />
    ));
}
