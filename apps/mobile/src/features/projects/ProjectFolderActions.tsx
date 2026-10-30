import { useAtomValue } from "@effect/atom-react";
import {
  copyProjectFolder,
  linkProjectFolders,
  syncProjectFolder,
} from "@t3tools/client-runtime/operations/project-folder";
import {
  getAddProjectInitialQuery,
  getCloneDestinationPath,
} from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthFilesystemWriteScope,
  ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { appAtomRegistry } from "../../state/atom-registry";
import { uuidv4 } from "../../lib/uuid";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  createNewTaskDraft,
  appendComposerDraftAttachments,
} from "../../state/use-composer-drafts";
import { createPastedTextComposerAttachment } from "../../lib/composerImages";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";

export function ProjectFolderActions(props: {
  readonly projectRef: ScopedProjectRef;
  readonly sourceThreadRef?: ScopedThreadRef;
  readonly threadActive?: boolean;
  readonly onCopied?: (project: EnvironmentProject) => void;
}) {
  const project = useProject(props.projectRef);
  const { environments } = useEnvironments();
  const source = environments.find(
    (entry) => entry.environmentId === props.projectRef.environmentId,
  );
  const supported = source?.serverConfig?.environment?.capabilities?.projectFolderTransfer === true;
  const writable = useEnvironmentsWithScope(environments, AuthFilesystemWriteScope);
  const creatable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const targets = environments.filter(
    (entry) =>
      entry.environmentId !== props.projectRef.environmentId &&
      entry.connection.phase === "connected" &&
      entry.serverConfig?.environment?.capabilities?.projectFolderTransfer === true &&
      writable.has(entry.environmentId) &&
      creatable.has(entry.environmentId),
  );
  const [targetId, setTargetId] = useState<string | null>(null);
  const target = targets.find((entry) => entry.environmentId === targetId) ?? targets[0];
  const [pathOverride, setPathOverride] = useState<string | null>(null);
  const path =
    pathOverride ??
    getCloneDestinationPath(
      getAddProjectInitialQuery(target?.serverConfig?.settings.addProjectBaseDirectory),
      project?.workspaceRoot.split(/[\\/]/).pop(),
    );
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const selectDetail = useSelectWorkspaceDetail();
  const query =
    supported && project
      ? projectEnvironment.folderSyncGet({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null;
  const sync = useEnvironmentQuery(query);
  const pair = sync.data;
  const canExport = useAtomValue(
    projectEnvironment.folderExport.permissionAtom(props.projectRef.environmentId),
  );
  const canCopy = useAtomValue(
    projectEnvironment.folderImport.permissionAtom(target?.environmentId ?? null),
  );
  const canSyncHere = useAtomValue(
    projectEnvironment.folderSyncSet.permissionAtom(props.projectRef.environmentId),
  );
  const canSyncPeer = useAtomValue(
    projectEnvironment.folderSyncSet.permissionAtom(pair?.peerEnvironmentId ?? null),
  );
  if (!supported || !project || project.repositoryIdentity?.locator.remoteUrl) return null;

  const run = (action: "copy" | "sync" | "unlink") => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    void execute(action)
      .catch((cause) =>
        setMessage(cause instanceof Error ? cause.message : "Folder operation failed."),
      )
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const execute = async (action: "copy" | "sync" | "unlink") => {
    if (action === "sync" && pair) {
      await syncProjectFolder(
        appAtomRegistry,
        projectEnvironment,
        { environmentId: project.environmentId, cwd: project.workspaceRoot },
        pair,
        setMessage,
      );
    } else if (action === "unlink" && pair) {
      for (const folder of [
        { environmentId: pair.peerEnvironmentId, cwd: pair.peerPath },
        { environmentId: project.environmentId, cwd: project.workspaceRoot },
      ]) {
        const result = await runAtomCommand(
          appAtomRegistry,
          projectEnvironment.folderSyncSet,
          { environmentId: folder.environmentId, input: { cwd: folder.cwd, state: null } },
          { label: "Unlink folder sync", reportFailure: false },
        );
        if (result._tag === "Failure") return setMessage(String(squashAtomCommandFailure(result)));
      }
      setMessage("Folders unlinked. Both copies are kept.");
    } else if (action === "copy" && target) {
      controller.current = new AbortController();
      const cwd = await copyProjectFolder(appAtomRegistry, projectEnvironment, {
        source: { environmentId: project.environmentId, cwd: project.workspaceRoot },
        targetEnvironmentId: target.environmentId,
        destinationPath: path.trim(),
        signal: controller.current.signal,
        onProgress: (copied, total) =>
          setMessage(`Copying ${Math.round(total === 0 ? 100 : (copied / total) * 100)}%`),
      });
      const projectId = ProjectId.make(uuidv4());
      const created = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.create,
        {
          environmentId: target.environmentId,
          input: { projectId, title: project.title, workspaceRoot: cwd },
        },
        { label: "Add copied folder", reportFailure: false },
      );
      if (created._tag === "Failure")
        return setMessage(
          `Folder copied to ${cwd}, but the project could not be added. Add that folder on ${target.label}.`,
        );
      if (linked)
        await linkProjectFolders(
          appAtomRegistry,
          projectEnvironment,
          { environmentId: project.environmentId, cwd: project.workspaceRoot },
          { environmentId: target.environmentId, cwd },
        );
      if (props.sourceThreadRef) {
        const transcript = await runAtomCommand(
          appAtomRegistry,
          orchestrationEnvironment.threadTranscript,
          {
            environmentId: props.sourceThreadRef.environmentId,
            input: { threadId: props.sourceThreadRef.threadId },
          },
          { label: "Save thread context", reportFailure: false },
        );
        if (transcript._tag === "Failure")
          return setMessage(String(squashAtomCommandFailure(transcript)));
        const attachment = await createPastedTextComposerAttachment({
          text:
            threadTranscriptHeader(props.sourceThreadRef.environmentId, transcript.value) +
            transcript.value.items.map((item) => `${JSON.stringify(item)}\n`).join(""),
          name: "Previous thread.jsonl",
          maxBytes:
            target.serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ??
            1024 * 1024,
        });
        const draftId = createNewTaskDraft({ environmentId: target.environmentId, projectId });
        appendComposerDraftAttachments(draftId, [attachment]);
        selectDetail({
          name: "Thread",
          params: {
            draft: {
              environmentId: target.environmentId,
              projectId,
              title: project.title,
              draftId,
            },
          },
        });
      } else props.onCopied?.({ ...created.value, environmentId: target.environmentId });
      setMessage(`Folder copied to ${target.label}. The original stays here.`);
    }
    if (query) appAtomRegistry.refresh(query);
  };

  return (
    <View className="gap-3 p-4">
      <Text className="text-base font-t3-medium text-foreground">Folder transfer and sync</Text>
      {pair ? (
        <>
          <Text className="text-sm text-foreground-muted">
            Manual sync with {pair.peerPath}, including deletions. Stop agents in both folders
            before syncing.
          </Text>
          <Button
            label="Sync folders"
            disabled={busy || !canSyncHere || !canSyncPeer || props.threadActive}
            onPress={() => void run("sync")}
          />
          <Button
            label="Unlink sync"
            disabled={busy || !canSyncHere || !canSyncPeer}
            onPress={() => void run("unlink")}
          />
        </>
      ) : targets.length ? (
        <>
          {targets.map((entry) => (
            <SelectionRow
              key={entry.environmentId}
              title={entry.label}
              selected={entry.environmentId === target?.environmentId}
              disabled={busy}
              onPress={() => {
                setTargetId(entry.environmentId);
                setPathOverride(null);
              }}
            />
          ))}
          <AppTextInput
            accessibilityLabel="Destination folder"
            className="min-h-11 rounded-xl bg-card px-3 text-foreground"
            value={path}
            onChangeText={setPathOverride}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {canSyncHere ? (
            <View className="flex-row items-center gap-3">
              <Text className="flex-1 text-sm text-foreground">
                Link for manual two-way sync, including deletions
              </Text>
              <ThemedSwitch value={linked} onValueChange={setLinked} disabled={busy} />
            </View>
          ) : null}
          <Text className="text-sm text-foreground-muted">
            Copies all files, including hidden files and secrets. Up to 1 GiB and 10,000 entries.
            The original stays here. Copies sync only when you click Sync.
          </Text>
          <Button
            label={props.sourceThreadRef ? "Copy folder and continue thread" : "Copy folder"}
            disabled={busy || !canExport || !canCopy || !path.trim() || props.threadActive}
            onPress={() => void run("copy")}
          />
          {busy ? <Button label="Cancel copy" onPress={() => controller.current?.abort()} /> : null}
        </>
      ) : (
        <Text className="text-sm text-foreground-muted">
          Connect another machine with folder transfer support to copy this folder.
        </Text>
      )}
      {message ? (
        <Text accessibilityRole="text" className="text-sm text-foreground-muted">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
