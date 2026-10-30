import {
  copyOrSyncProjectFolder,
  linkProjectFolders,
} from "@t3tools/client-runtime/operations/project-folder";
import {
  normalizeProjectPathForComparison,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { threadContextAttachment } from "../lib/threadContextAttachment";
import { useParams } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getAddProjectInitialQuery,
  getCloneDestinationPath,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";
import {
  type EnvironmentId,
  type ProjectIgnoredFile,
  type ScopedProjectRef,
  type ScopedThreadRef,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  type CloneProtocol,
  cloneUrlForProtocol,
  cloneUrlProtocol,
} from "@t3tools/shared/cloneUrl";
import { ArrowRightIcon } from "lucide-react";
import { isElectron } from "../env";
import { useId, useState, useRef } from "react";
import { create } from "zustand";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import {
  COPYABLE_FILE_MAX_BYTES,
  addProjectToMachine,
  isDefaultCopiedFile,
} from "../lib/addProjectToMachine";
import { formatBytes } from "../lib/formatBytes";
import { newProjectId, randomUUID } from "../lib/utils";
import {
  readProject,
  readThreadShell,
  subscribeProject,
  useProject,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

interface AddProjectToMachineRequest {
  readonly projectRef: ScopedProjectRef;
  readonly targetEnvironmentId: EnvironmentId | null;
  readonly sourceThreadRef?: ScopedThreadRef;
}

const useRequest = create<{ request: AddProjectToMachineRequest | null; session: number }>(() => ({
  request: null,
  session: 0,
}));

let endRequestWithProject: (() => void) | null = null;

/** Opens the dialog that clones a project onto another connected machine. */
export function openAddProjectToMachine(request: AddProjectToMachineRequest) {
  if (readProject(request.projectRef) === null) return;
  endRequestWithProject?.();
  // The request ends when its project goes away, so a project that comes back
  // later cannot reopen a dialog nobody asked for.
  endRequestWithProject = subscribeProject(request.projectRef, (project) => {
    if (project === null) close();
  });
  useRequest.setState((state) => ({ request, session: state.session + 1 }));
}

function close() {
  endRequestWithProject?.();
  endRequestWithProject = null;
  useRequest.setState({ request: null });
}

export function AddProjectToMachineDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  return request ? <AddProjectToMachineDialog key={session} request={request} /> : null;
}

function AddProjectToMachineDialog({ request }: { request: AddProjectToMachineRequest }) {
  const id = useId();
  const project = useProject(request.projectRef);
  const handleNewThread = useNewThreadHandler();
  const { draftId: routeDraftId } = useParams({ strict: false });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const projectEnvironments = useLogicalProjectEnvironments(project, false);
  const newTargets = useAddProjectTargets(project, projectEnvironments);
  const source = environments.find((env) => env.environmentId === request.projectRef.environmentId);
  const folderSync = useEnvironmentQuery(
    project &&
      !project.repositoryIdentity?.locator.remoteUrl &&
      source?.serverConfig?.environment.capabilities.projectFolderTransfer
      ? projectEnvironment.folderSyncGet({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );
  const targets = [
    ...newTargets,
    ...projectEnvironments.filter(
      (env) =>
        env.environmentId === folderSync.data?.peerEnvironmentId &&
        !newTargets.some((target) => target.environmentId === env.environmentId),
    ),
  ];
  const [targetId, setTargetId] = useState(request.targetEnvironmentId);
  const target = targets.find((t) => t.environmentId === targetId) ?? targets[0] ?? null;
  const reuseSyncedFolder = Boolean(
    folderSync.data && target?.environmentId === folderSync.data.peerEnvironmentId,
  );

  const sourceUrl =
    project?.repositoryIdentity?.origin?.remoteUrl ??
    project?.repositoryIdentity?.locator.remoteUrl ??
    "";
  const [protocol, setProtocol] = useState<CloneProtocol | null>(() => cloneUrlProtocol(sourceUrl));
  const sshUrl = cloneUrlForProtocol(sourceUrl, "ssh");
  const httpsUrl = cloneUrlForProtocol(sourceUrl, "https");
  const remoteUrl =
    (protocol === "ssh" ? sshUrl : protocol === "https" ? httpsUrl : null) ?? sourceUrl;

  const canCopy = useAtomValue(
    projectEnvironment.folderImport.permissionAtom(target?.environmentId ?? null),
  );
  const canExport = useAtomValue(
    projectEnvironment.folderExport.permissionAtom(request.projectRef.environmentId),
  );
  const targetEnvironment = environments.find((env) => env.environmentId === target?.environmentId);
  const isFolder = sourceUrl.length === 0;
  const defaultPath = getCloneDestinationPath(
    getAddProjectInitialQuery(targetEnvironment?.serverConfig?.settings.addProjectBaseDirectory),
    isFolder
      ? inferProjectTitleFromPath(project?.workspaceRoot ?? "folder")
      : getCloneDirectoryName(sourceUrl),
  );
  const [pathOverride, setPathOverride] = useState<string | null>(null);
  const destinationPath = reuseSyncedFolder
    ? folderSync.data!.peerPath
    : (pathOverride ?? defaultPath);

  const existingProject = projects.find(
    (candidate) =>
      candidate.environmentId === target?.environmentId &&
      normalizeProjectPathForComparison(candidate.workspaceRoot) ===
        normalizeProjectPathForComparison(destinationPath),
  );
  const supportsFolderStatus = Boolean(
    source?.serverConfig?.environment.capabilities.projectFolderAutoSync &&
    targetEnvironment?.serverConfig?.environment.capabilities.projectFolderAutoSync,
  );
  const supportsAutomaticSync = isElectron && supportsFolderStatus;
  const canListFiles =
    !isFolder && source?.serverConfig?.environment.capabilities.ignoredFileListing === true;
  const ignoredFiles = useEnvironmentQuery(
    project && canListFiles
      ? projectEnvironment.listIgnoredFiles({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );
  const files = ignoredFiles.data?.files ?? [];
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const selectedFiles = selected ?? defaultSelection(files);
  const copyable = files.filter((file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES);
  const selectedBytes = files
    .filter((file) => selectedFiles.has(file.path))
    .reduce((total, file) => total + file.byteLength, 0);

  const [keepInSync, setKeepInSync] = useState(false);
  const canLinkSync = useAtomValue(
    projectEnvironment.folderSyncSet.permissionAtom(request.projectRef.environmentId),
  );
  const canSyncPeer = useAtomValue(
    projectEnvironment.folderSyncSet.permissionAtom(target?.environmentId ?? null),
  );
  const [submitting, setSubmitting] = useState(false);
  const copyController = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const dismiss = () => {
    if (submitting) {
      copyController.current?.abort();
      return;
    }
    close();
  };
  const [error, setError] = useState<string | null>(null);

  // The project or every target can vanish while the dialog is open. Submitting
  // before the file list loads would silently skip the default .env copies.
  const unavailable =
    project === null ||
    target === null ||
    (isFolder && (!canCopy || !canExport)) ||
    (reuseSyncedFolder && (!canLinkSync || !canSyncPeer)) ||
    (canListFiles && ignoredFiles.data === null && ignoredFiles.error === null);
  const toggleFile = (path: string, checked: boolean) => {
    const next = new Set(selectedFiles);
    if (checked) next.add(path);
    else next.delete(path);
    setSelected(next);
  };

  // Lands the user on the new machine right away; its composer shows the clone
  // and holds sends until it finishes. A draft open on the source project moves
  // over with whatever was typed in it.
  const openClonedProject = (targetRef: ScopedProjectRef) => {
    const drafts = useComposerDraftStore.getState();
    const draftId = routeDraftId as DraftId | undefined;
    const draft = draftId ? drafts.getDraftSession(draftId) : null;
    if (
      draftId &&
      draft &&
      !draft.promotedTo &&
      draft.environmentId === request.projectRef.environmentId &&
      draft.projectId === request.projectRef.projectId
    ) {
      drafts.setDraftThreadContext(draftId, {
        projectRef: targetRef,
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      return;
    }
    void handleNewThread(targetRef);
  };

  const submit = async () => {
    if (!project || !target || submitting) return;
    if (destinationPath.trim().length === 0) {
      setError("Choose a folder on the other machine.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const projectId = existingProject?.id ?? newProjectId();
    const fail = (message: string) => {
      setError(message);
      setSubmitting(false);
    };
    try {
      if (isFolder) {
        if (
          request.sourceThreadRef &&
          readThreadShell(request.sourceThreadRef)?.runtime?.activeRunId
        ) {
          return fail("Stop the current turn before continuing on another machine.");
        }
        const controller = new AbortController();
        copyController.current = controller;
        if (reuseSyncedFolder) setProgress("Preparing continuation…");
        let transcript: File | null = null;
        if (request.sourceThreadRef) {
          const result = await runAtomCommand(
            appAtomRegistry,
            orchestrationEnvironment.threadTranscript,
            {
              environmentId: request.sourceThreadRef.environmentId,
              input: { threadId: request.sourceThreadRef.threadId },
            },
            { label: "Save thread context", reportFailure: false },
          );
          if (result._tag === "Failure") return fail(String(squashAtomCommandFailure(result)));
          transcript = threadContextAttachment(request.sourceThreadRef.environmentId, result.value);
          const limit =
            targetEnvironment?.serverConfig?.environment.capabilities.fileAttachments
              ?.maxUploadBytes;
          if (limit !== undefined && transcript.size > limit)
            return fail(
              "This thread snapshot exceeds the destination's attachment limit. Copy the folder from project settings and attach a smaller handoff to a new thread.",
            );
        }
        const { cwd, reused } = await copyOrSyncProjectFolder(appAtomRegistry, projectEnvironment, {
          source: { environmentId: project.environmentId, cwd: project.workspaceRoot },
          targetEnvironmentId: target.environmentId,
          destinationPath: destinationPath.trim(),
          reuseExisting: supportsFolderStatus,
          signal: controller.signal,
          onProgress: (copied, total) =>
            setProgress(`${formatBytes(copied)} of ${formatBytes(total)}`),
        });
        if (reused)
          setProgress(keepInSync ? "Linking existing folders…" : "Preparing continuation…");
        if (!existingProject) {
          const created = await runAtomCommand(
            appAtomRegistry,
            projectEnvironment.create,
            {
              environmentId: target.environmentId,
              input: { projectId, title: project.title, workspaceRoot: cwd },
            },
            { label: "Add copied folder", reportFailure: false },
          );
          if (created._tag === "Failure") {
            return fail(
              `Files were copied to ${cwd}, but the project could not be added. Add that existing folder on ${target.label}.`,
            );
          }
        }
        if (keepInSync && !reuseSyncedFolder)
          await linkProjectFolders(
            appAtomRegistry,
            projectEnvironment,
            { environmentId: project.environmentId, cwd: project.workspaceRoot },
            { environmentId: target.environmentId, cwd },
            {
              automatic: supportsAutomaticSync,
              coordinatorEnvironmentId: primaryEnvironmentId ?? project.environmentId,
            },
          );
        const targetRef = scopeProjectRef(target.environmentId, projectId);
        if (transcript) {
          const draft = await handleNewThread(targetRef);
          if (!draft) return fail(`Folder copied to ${cwd}. Open a new thread there to continue.`);
          const drafts = useComposerDraftStore.getState();
          drafts.setDraftThreadContext(draft.draftId, {
            projectRef: targetRef,
            environmentSelection: "manual",
            loadBalancedEnvironmentId: null,
          });
          const accepted = drafts.addFiles(draft.draftId, [
            {
              type: "file",
              id: randomUUID(),
              name: transcript.name,
              mimeType: transcript.type,
              sizeBytes: transcript.size,
              file: transcript,
            },
          ]);
          if (accepted.length === 0)
            return fail("The folder was copied, but the thread snapshot could not be attached.");
        } else {
          openClonedProject(targetRef);
        }
        close();
        return;
      }
      await addProjectToMachine({
        source: { environmentId: project.environmentId, cwd: project.workspaceRoot },
        subdirectory: projectSubdirectory(
          project.repositoryIdentity?.rootPath,
          project.workspaceRoot,
        ),
        target: { environmentId: target.environmentId, label: target.label },
        projectId,
        title: project.title,
        remoteUrl,
        destinationPath: destinationPath.trim(),
        files: files.filter((file) => selectedFiles.has(file.path)).map((file) => file.path),
      });
      close();
      openClonedProject(scopeProjectRef(target.environmentId, projectId));
    } catch (cause) {
      setError(
        copyController.current?.signal.aborted
          ? "Folder copy cancelled. The source is unchanged."
          : cause instanceof Error
            ? cause.message
            : "Could not copy the project.",
      );
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {reuseSyncedFolder ? "Continue on another machine" : "Add to another machine"}
            </DialogTitle>
            <DialogDescription>
              {reuseSyncedFolder
                ? "Continue in the existing folder on the other machine. Folder syncing runs separately from the conversation."
                : isFolder
                  ? `Use the existing ${project?.title ?? "folder"} on the other machine, or copy it if missing. Both copies stay available.${keepInSync ? (supportsAutomaticSync ? " Changes sync automatically while T3 is running." : " Sync runs when requested.") : " The copies do not sync."}`
                  : `Clone ${project?.repositoryIdentity?.displayName ?? project?.title} and bring the local files git does not track.`}
              {request.sourceThreadRef
                ? " Opens a new thread with a saved transcript attached. Review and send your next message there; the original thread stays here."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(source?.serverConfig ?? null)}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{source?.label ?? "This machine"}</span>
                </span>
                <span className="flex min-w-0 font-mono text-muted-foreground text-xs">
                  <MiddleTruncate value={project?.workspaceRoot ?? ""} />
                </span>
              </div>
              <div className="flex w-28 flex-col items-center gap-0.5 text-muted-foreground text-xs">
                <span>
                  {reuseSyncedFolder
                    ? "Use existing folder"
                    : isFolder
                      ? "Use or copy folder"
                      : "git clone"}
                </span>
                <span className="flex w-full items-center">
                  <span className="h-px flex-1 bg-border" />
                  <ArrowRightIcon className="-ms-1 size-3.5" aria-hidden />
                </span>
                <span>
                  {reuseSyncedFolder
                    ? "changes only"
                    : isFolder
                      ? "all files"
                      : selectedFiles.size === 0
                        ? "no files"
                        : `+ ${selectedFiles.size} ${selectedFiles.size === 1 ? "file" : "files"}`}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {targets.length > 1 ? (
                  <Select
                    disabled={submitting}
                    value={target?.environmentId ?? null}
                    onValueChange={(value) => {
                      if (value) setTargetId(value);
                    }}
                    items={targets.map((t) => ({ value: t.environmentId, label: t.label }))}
                  >
                    <SelectTrigger size="sm" aria-label="Machine to add the project to">
                      {target ? (
                        <EnvironmentMachineIcon kind={target.machine} className="size-3.5" />
                      ) : null}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((t) => (
                        <SelectItem key={t.environmentId} value={t.environmentId}>
                          <span className="inline-flex items-center gap-1.5">
                            <EnvironmentMachineIcon kind={t.machine} className="size-3" />
                            {t.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
                    {target ? (
                      <EnvironmentMachineIcon kind={target.machine} className="size-3.5 shrink-0" />
                    ) : null}
                    <span className="truncate">{target?.label ?? "No machine available"}</span>
                  </span>
                )}
                <span className="flex min-w-0 font-mono text-muted-foreground text-xs">
                  <MiddleTruncate value={destinationPath} />
                </span>
              </div>
            </div>

            {!isFolder ? (
              <div className="flex flex-col gap-1.5">
                <Label>Clone over</Label>
                {sshUrl && httpsUrl ? (
                  <ToggleGroup
                    aria-label="Clone protocol"
                    value={protocol ? [protocol] : []}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "ssh" || value === "https") setProtocol(value);
                    }}
                  >
                    <Toggle value="ssh">SSH</Toggle>
                    <Toggle value="https">HTTPS</Toggle>
                  </ToggleGroup>
                ) : null}
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {remoteUrl}
                </span>
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-path`}>Folder on {target?.label ?? "the other machine"}</Label>
              <Input
                id={`${id}-path`}
                disabled={submitting || reuseSyncedFolder}
                value={destinationPath}
                onChange={(event) => setPathOverride(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            {canListFiles ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Label className="flex-1">Copy ignored files</Label>
                  {copyable.length > 0 ? (
                    <>
                      <span className="text-muted-foreground text-xs">
                        {selectedFiles.size} of {files.length}
                        {selectedBytes > 0 ? ` · ${formatBytes(selectedBytes)}` : ""}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setSelected(
                            selectedFiles.size === copyable.length
                              ? new Set()
                              : new Set(copyable.map((file) => file.path)),
                          )
                        }
                      >
                        {selectedFiles.size === copyable.length ? "None" : "All"}
                      </Button>
                    </>
                  ) : null}
                </div>
                {ignoredFiles.error ? (
                  <p className="text-destructive-foreground text-xs">{ignoredFiles.error}</p>
                ) : files.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {ignoredFiles.isSuccess
                      ? "No ignored files to copy."
                      : "Finding ignored files…"}
                  </p>
                ) : (
                  <div className="max-h-52 overflow-y-auto rounded-md border">
                    {files.map((file) => (
                      <IgnoredFileRow
                        key={file.path}
                        file={file}
                        checked={selectedFiles.has(file.path)}
                        onCheckedChange={(checked) => toggleFile(file.path, checked)}
                      />
                    ))}
                  </div>
                )}
                {ignoredFiles.data?.truncated ? (
                  <p className="text-muted-foreground text-xs">
                    Showing the first {files.length} files.
                  </p>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  Files are copied after the clone finishes. Folders git ignores whole, like
                  node_modules, are left out.
                </p>
              </div>
            ) : null}

            {isFolder && canLinkSync && !reuseSyncedFolder ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={keepInSync}
                  onCheckedChange={(checked) => setKeepInSync(checked === true)}
                  disabled={submitting}
                />
                {supportsAutomaticSync
                  ? "Keep folders in automatic two-way sync (including deletions)"
                  : "Link folders for manual two-way sync (including deletions)"}
              </label>
            ) : null}
            {isFolder ? (
              <p className="text-muted-foreground text-xs">
                Includes hidden and binary files, including secrets stored in this folder. Links
                must stay inside the folder.
              </p>
            ) : null}
            {progress ? (
              <p role="status" className="text-muted-foreground text-sm">
                {progress}
              </p>
            ) : null}
            {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" disabled={unavailable || submitting}>
              {submitting
                ? isFolder
                  ? reuseSyncedFolder
                    ? "Preparing…"
                    : "Copying…"
                  : "Starting…"
                : reuseSyncedFolder
                  ? `Continue on ${target?.label ?? "machine"}`
                  : `${isFolder ? "Continue" : "Clone"} on ${target?.label ?? "machine"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A project can be rooted below its repository's top folder. The clone lands
 * at the top, so copied files keep the same path below it.
 */
function projectSubdirectory(repositoryRoot: string | undefined, workspaceRoot: string) {
  if (!repositoryRoot) return "";
  const prefix = repositoryRoot.replace(/[\\/]+$/, "");
  const rest = workspaceRoot.slice(prefix.length);
  return workspaceRoot.startsWith(prefix) && /^[\\/]/.test(rest)
    ? rest.slice(1).replaceAll("\\", "/")
    : "";
}

function defaultSelection(files: readonly ProjectIgnoredFile[]): ReadonlySet<string> {
  return new Set(
    files
      .filter(
        (file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES && isDefaultCopiedFile(file.path),
      )
      .map((file) => file.path),
  );
}

function IgnoredFileRow({
  file,
  checked,
  onCheckedChange,
}: {
  file: ProjectIgnoredFile;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const tooLarge = file.byteLength > COPYABLE_FILE_MAX_BYTES;
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm not-last:border-b has-disabled:cursor-not-allowed has-disabled:opacity-64">
      <Checkbox checked={checked} disabled={tooLarge} onCheckedChange={onCheckedChange} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {tooLarge ? "Over 1 MB" : formatBytes(file.byteLength)}
      </span>
    </label>
  );
}
