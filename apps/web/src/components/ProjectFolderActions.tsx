import { useAtomValue } from "@effect/atom-react";
import { syncProjectFolder } from "@t3tools/client-runtime/operations/project-folder";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";

import { useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironments } from "../state/environments";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { Button } from "./ui/button";

export function ProjectFolderActions({ projectRef }: { projectRef: ScopedProjectRef }) {
  const project = useProject(projectRef);
  const { environments } = useEnvironments();
  const source = environments.find(
    (environment) => environment.environmentId === projectRef.environmentId,
  );
  const supported = source?.serverConfig?.environment?.capabilities?.projectFolderTransfer === true;
  const query =
    supported && project
      ? projectEnvironment.folderSyncGet({
          environmentId: projectRef.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null;
  const sync = useEnvironmentQuery(query);
  const pair = sync.data;
  const canWrite = useAtomValue(
    projectEnvironment.folderSyncSet.permissionAtom(projectRef.environmentId),
  );
  const canWritePeer = useAtomValue(
    projectEnvironment.folderSyncSet.permissionAtom(pair?.peerEnvironmentId ?? null),
  );
  const targets = useAddProjectTargets(project, undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  if (!supported || !project || project.repositoryIdentity?.locator.remoteUrl) return null;

  const act = (unlink: boolean) => {
    if (!pair || pending.current) return;
    pending.current = true;
    setBusy(true);
    void execute(unlink).finally(() => {
      pending.current = false;
      setBusy(false);
    });
  };
  const execute = async (unlink: boolean) => {
    if (!pair) return;
    try {
      if (unlink) {
        for (const folder of [
          { environmentId: pair.peerEnvironmentId, cwd: pair.peerPath },
          { environmentId: projectRef.environmentId, cwd: project.workspaceRoot },
        ]) {
          const result = await runAtomCommand(
            appAtomRegistry,
            projectEnvironment.folderSyncSet,
            { environmentId: folder.environmentId, input: { cwd: folder.cwd, state: null } },
            { label: "Unlink folder sync", reportFailure: false },
          );
          if (result._tag === "Failure")
            return setMessage(String(squashAtomCommandFailure(result)));
        }
        setMessage("Folders unlinked. Both copies are kept.");
      } else {
        await syncProjectFolder(
          appAtomRegistry,
          projectEnvironment,
          { environmentId: projectRef.environmentId, cwd: project.workspaceRoot },
          pair,
          setMessage,
        );
      }
      if (query) appAtomRegistry.refresh(query);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Folder sync failed.");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {targets.length > 0 && !pair ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null })}
          >
            Copy to another machine
          </Button>
        ) : null}
        {pair ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canWrite || !canWritePeer}
              onClick={() => void act(false)}
            >
              {busy ? "Working…" : "Sync folders"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !canWrite || !canWritePeer}
              onClick={() => void act(true)}
            >
              Unlink sync
            </Button>
          </>
        ) : null}
      </div>
      {pair ? (
        <p className="text-xs text-muted-foreground">
          Manual two-way sync with {pair.peerPath}. Sync also applies file deletions. Stop agents
          working in either folder before syncing.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
