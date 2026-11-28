import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import {
  sharedProjectFileStatus,
  sharedProjectMappingStatus,
} from "@t3tools/client-runtime/state/shared-capabilities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SharedProjectBinding,
  SharedProjectManifest,
  SharedProjectSubscription,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function SharedProjectFilesSettings({
  environmentId,
  project,
  binding,
  subscription,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: SharedProjectManifest | undefined;
  readonly binding: SharedProjectBinding | undefined;
  readonly subscription: SharedProjectSubscription;
}) {
  const { environments } = useEnvironments();
  const owner = environments.find(
    (machine) => machine.environmentId === subscription.ownerEnvironmentId,
  );
  const sourceUrl = linkableMachines({
    environments,
    threadEnvironmentId: environmentId,
    links: [],
    connect: new Map(),
  })
    .find((machine) => machine.environmentId === subscription.ownerEnvironmentId)
    ?.urls.find((url) => url.startsWith("https://"));
  const canGrant = useAtomValue(
    sharedCapabilities.sharedProjectGrant.permissionAtom(subscription.ownerEnvironmentId),
  );
  const canReceive = useAtomValue(
    sharedCapabilities.sharedProjectEnrollmentCommand.permissionAtom(environmentId, {
      operation: "connect",
      receiveFiles: true,
    }),
  );
  const canConfigure = useAtomValue(
    sharedCapabilities.sharedProjectEnrollmentCommand.permissionAtom(environmentId),
  );
  const canAct = useAtomValue(
    sharedCapabilities.sharedProjectContentCommand.permissionAtom(environmentId),
  );
  const enroll = useAtomCommand(sharedCapabilities.enrollSharedProject, { reportFailure: false });
  const configure = useAtomCommand(sharedCapabilities.sharedProjectEnrollmentCommand, {
    reportFailure: false,
  });
  const command = useAtomCommand(sharedCapabilities.sharedProjectContentCommand, {
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const state = useEnvironmentQuery(
    expanded && project
      ? sharedCapabilities.sharedProjectContentState({
          environmentId,
          input: { sharedProjectId: project.id },
        })
      : null,
  );
  const [review, setReview] = useState<{
    readonly rootId: string;
    readonly generation: number;
    readonly cursor: number;
  } | null>(null);
  const conflicts = useEnvironmentQuery(
    review
      ? sharedCapabilities.sharedProjectContentConflict({
          environmentId,
          input: {
            sharedProjectId: subscription.sharedProjectId,
            rootId: review.rootId,
            cursor: review.cursor,
          },
        })
      : null,
  );
  const toggle = async () => {
    if (inFlight.current) return;
    if (!subscription.receiveFiles && (!sourceUrl || !project)) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = subscription.receiveFiles
        ? await configure({
            environmentId,
            input: {
              operation: "receive-files",
              sharedProjectId: subscription.sharedProjectId,
              enabled: false,
            },
          })
        : await enroll({
            ownerId: subscription.ownerEnvironmentId,
            destinationId: environmentId,
            sharedProjectId: subscription.sharedProjectId,
            sourceUrl: sourceUrl!,
            receiveFiles: true,
          });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else setExpanded(true);
    } catch {
      setError("Could not change file receiving. Refresh the connection and retry.");
    }
    inFlight.current = false;
    setBusy(false);
  };
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    if (inFlight.current) return;
    if (
      input.operation === "resolve" &&
      !(await requestConfirmDialog(
        input.choice === "owner"
          ? "Use the owner's saved versions for all conflicts in this folder? Saved local versions will be preserved."
          : "Keep this machine's versions for all conflicts in this folder? Saved owner versions will be preserved.",
      ))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else if (input.operation === "resolve") setReview(null);
    } catch {
      setError("Could not update folder preparation. Refresh its status and retry.");
    }
    inFlight.current = false;
    setBusy(false);
  };
  const canEnable =
    !!project &&
    sharedProjectMappingStatus(project, binding, environmentId).phase === "mapped" &&
    !subscription.paused &&
    project.roots.some((root) => root.kind === "files") &&
    !!sourceUrl &&
    owner?.serverConfig?.environment.capabilities.sharedProjectFileContent === 1 &&
    canGrant &&
    canReceive;
  const changed = !!review && !!conflicts.data && review.generation !== conflicts.data.generation;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          File receiving {subscription.receiveFiles ? "on" : "off"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide folder status" : "Folder preparation"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (subscription.receiveFiles ? !canConfigure : !canEnable)}
            onClick={() => void toggle()}
          >
            {subscription.receiveFiles ? "Stop receiving files" : "Receive file folders"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Receives the owner's non-Git file folders in the background. Local edits stay local;
        conflicts keep both versions. Git repositories and account sign-ins are prepared separately.
      </p>
      {!subscription.receiveFiles && !canEnable ? (
        <p className="text-xs text-muted-foreground">
          Map file folders and resume the owner connection first. Use an updated owner with a
          reachable HTTPS route and access to manage its grant and write files here.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {expanded ? (
        <div className="space-y-3">
          {state.error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {state.error}
            </p>
          ) : null}
          {!project ? (
            <p className="text-xs text-muted-foreground">
              Refresh the owner's project definitions first.
            </p>
          ) : !state.data ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading folder status…
            </p>
          ) : (
            project.roots.map((root) => {
              const receipt = state.data?.roots.find((value) => value.rootId === root.id);
              const status = sharedProjectFileStatus({
                project,
                binding,
                subscription,
                receipt,
                environmentId,
              });
              return (
                <div key={root.id} className="space-y-1">
                  <p className="text-sm">
                    {root.name} · {root.kind === "git" ? "Repository setup required" : status.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {root.kind === "git"
                      ? "Git history is not transferred by file receiving."
                      : status.detail}
                  </p>
                  {root.kind === "files" ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          busy || !canAct || !subscription.receiveFiles || subscription.paused
                        }
                        onClick={() =>
                          void run({
                            operation: "refresh",
                            sharedProjectId: project.id,
                            rootId: root.id,
                          })
                        }
                      >
                        Check preparation
                      </Button>
                      {receipt?.conflictCount ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            setReview({
                              rootId: root.id,
                              generation: receipt.generation,
                              cursor: 0,
                            })
                          }
                        >
                          Review conflicts
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review folder conflicts</DialogTitle>
            <DialogDescription>
              Choose saved versions for these conflicting paths. Both versions remain preserved;
              later local edits are protected.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {conflicts.error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {conflicts.error}
              </p>
            ) : !conflicts.data ? (
              <p role="status" className="text-sm">
                Loading conflicts…
              </p>
            ) : (
              <>
                <p className="text-sm">
                  {conflicts.data.total} conflicting paths ·{" "}
                  {project?.roots.find((root) => root.id === review?.rootId)?.name ?? "Folder"}
                </p>
                {changed ? (
                  <p role="alert" className="text-sm">
                    The conflict changed. Reload it before choosing a version.
                  </p>
                ) : null}
                <ul className="max-h-64 space-y-1 overflow-y-auto text-xs font-mono">
                  {conflicts.data.paths.map((path) => (
                    <li key={path} className="break-all">
                      {path}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !review || review.cursor === 0}
                    onClick={() => {
                      if (review) setReview({ ...review, cursor: Math.max(0, review.cursor - 64) });
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !review || conflicts.data.nextCursor === null}
                    onClick={() => {
                      if (
                        review &&
                        conflicts.data?.nextCursor !== null &&
                        conflicts.data?.nextCursor !== undefined
                      )
                        setReview({ ...review, cursor: conflicts.data.nextCursor });
                    }}
                  >
                    Next
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (review && conflicts.data)
                        setReview({ ...review, generation: conflicts.data.generation, cursor: 0 });
                      conflicts.refresh();
                    }}
                  >
                    Reload conflict
                  </Button>
                </div>
              </>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)}>
              Close
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canAct || changed || !review || !conflicts.data}
              onClick={() => {
                if (review)
                  void run({
                    operation: "resolve",
                    sharedProjectId: subscription.sharedProjectId,
                    rootId: review.rootId,
                    expectedGeneration: review.generation,
                    choice: "local",
                  });
              }}
            >
              Keep local versions
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy || !canAct || changed || !review || !conflicts.data}
              onClick={() => {
                if (review)
                  void run({
                    operation: "resolve",
                    sharedProjectId: subscription.sharedProjectId,
                    rootId: review.rootId,
                    expectedGeneration: review.generation,
                    choice: "owner",
                  });
              }}
            >
              Use saved owner versions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
