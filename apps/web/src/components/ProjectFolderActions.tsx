import { useAtomValue } from "@effect/atom-react";
import {
  linkProjectFolders,
  syncProjectFolder,
  unlinkProjectFolders,
} from "@t3tools/client-runtime/operations/project-folder";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { isElectron } from "../env";
import { useRef, useState } from "react";

import { useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { usePrimaryEnvironmentId } from "../state/environments";
import { folderSyncMessagesAtom, folderSyncMessageKey } from "../state/projectFolderAutoSync";
import { useEnvironments } from "../state/environments";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { Button } from "./ui/button";
import { SettingsRow } from "./settings/settingsLayout";

export function ProjectFolderActions({ projectRef }: { projectRef: ScopedProjectRef }) {
  const project = useProject(projectRef);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const automaticMessages = useAtomValue(folderSyncMessagesAtom);
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
  if (!supported || !project || (project.repositoryIdentity?.locator.remoteUrl && !pair))
    return null;

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
        await unlinkProjectFolders(
          appAtomRegistry,
          projectEnvironment,
          { environmentId: projectRef.environmentId, cwd: project.workspaceRoot },
          pair,
        );
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
    <SettingsRow
      title={pair ? "Folder sync" : "Copy folder"}
      description={
        pair ? (
          <>
            {pair.automatic ? "Automatic" : "Manual"} two-way sync with {pair.peerPath}, including
            deletions.
            {pair.automatic
              ? " Runs while T3 is open, including with its window closed. Pauses while agents work."
              : " Stop agents working in either folder before syncing."}
          </>
        ) : (
          "Copy this folder to another connected machine while keeping the original."
        )
      }
      status={
        message ||
        automaticMessages.get(
          folderSyncMessageKey(projectRef.environmentId, project.workspaceRoot),
        ) ? (
          <span role="status">
            {message ??
              automaticMessages.get(
                folderSyncMessageKey(projectRef.environmentId, project.workspaceRoot),
              )}
          </span>
        ) : undefined
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
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
              {isElectron &&
              !pair.automatic &&
              source?.serverConfig?.environment.capabilities.projectFolderAutoSync &&
              environments.find((env) => env.environmentId === pair.peerEnvironmentId)?.serverConfig
                ?.environment.capabilities.projectFolderAutoSync ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !canWrite || !canWritePeer}
                  onClick={() => {
                    if (!primaryEnvironmentId) return;
                    setBusy(true);
                    void linkProjectFolders(
                      appAtomRegistry,
                      projectEnvironment,
                      { environmentId: projectRef.environmentId, cwd: project.workspaceRoot },
                      { environmentId: pair.peerEnvironmentId, cwd: pair.peerPath },
                      { automatic: true, coordinatorEnvironmentId: primaryEnvironmentId },
                    )
                      .catch((cause) =>
                        setMessage(
                          cause instanceof Error ? cause.message : "Could not enable sync.",
                        ),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  Enable automatic sync
                </Button>
              ) : null}
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
      }
    />
  );
}
