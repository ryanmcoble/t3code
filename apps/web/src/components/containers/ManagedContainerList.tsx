import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { managedContainerStatus } from "@t3tools/client-runtime/state/shared-capabilities";
import type {
  ContainerSnapshot,
  EnvironmentId,
  ManagedContainer,
  ManagedContainerCommand,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironment } from "~/state/environments";
import { useThreadShell } from "~/state/entities";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function ManagedContainerList({
  environmentId,
  threadId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly snapshot?: ContainerSnapshot;
}) {
  const environment = useEnvironment(environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.managedContainers === 1;
  const query = useEnvironmentQuery(
    supported
      ? sharedCapabilities.managedContainers({ environmentId, input: threadId ? { threadId } : {} })
      : null,
  );
  const [limit, setLimit] = useState(20);
  if (!supported) return null;
  return (
    <section className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Managed resources</h4>
        <Button size="sm" variant="ghost" onClick={query.refresh}>
          Refresh ownership
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Only containers created with a durable T3 ownership receipt have lifecycle controls. Folder
        links do not grant ownership.
      </p>
      {query.error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {query.error}
        </p>
      ) : null}
      {query.data && !query.data.complete ? (
        <p role="status" className="text-xs text-muted-foreground">
          Partial history: showing the latest 1,000 resource receipts.
        </p>
      ) : null}
      {query.data?.items.slice(0, limit).map((resource) => (
        <ManagedContainerRow
          key={resource.resourceId}
          environmentId={environmentId}
          resource={resource}
          actorId={threadId ?? resource.threadId}
          state={
            snapshot?.engineId === resource.engineId && !snapshot.stale
              ? snapshot.containers.find((container) => container.id === resource.containerId)
                  ?.state
              : undefined
          }
          onRefresh={query.refresh}
        />
      ))}
      {query.data?.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No T3-managed containers. Existing Docker containers remain visible above.
        </p>
      ) : null}
      {(query.data?.items.length ?? 0) > limit ? (
        <Button size="sm" variant="ghost" onClick={() => setLimit(limit + 20)}>
          Show more receipts
        </Button>
      ) : null}
    </section>
  );
}

function ManagedContainerRow({
  environmentId,
  resource,
  actorId,
  state,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly resource: ManagedContainer;
  readonly actorId: ThreadId;
  readonly state: string | undefined;
  readonly onRefresh: () => void;
}) {
  const command = useAtomCommand(sharedCapabilities.managedContainerCommand, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    sharedCapabilities.managedContainerCommand.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const owner = useThreadShell({ environmentId, threadId: resource.threadId });
  const [error, setError] = useState<string | null>(null);
  const referenced = resource.references.includes(actorId);
  const shared = resource.references.length > 1;
  const run = async (operation: (typeof ManagedContainerCommand.Type)["operation"]) => {
    if (
      operation === "release" &&
      !(await requestConfirmDialog(
        shared
          ? "Detach this thread’s reference? The shared container keeps running."
          : "Release this disposable T3 container? T3 will stop it and remove only this container. Mounted workspace files remain on disk.",
        { variant: "destructive" },
      ))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: {
          resourceId: resource.resourceId,
          threadId: actorId,
          generation: resource.generation,
          operation,
        },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    } catch {
      setError("Could not complete this action. Refresh ownership and try again.");
    }
    setBusy(false);
    onRefresh();
  };
  const disabled = busy || !permitted || !referenced;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all text-xs font-medium">
          {owner?.title ? `Container for ${owner.title}` : "Disposable container"}
        </span>
        <Badge variant={resource.phase === "failed" || resource.failure ? "warning" : "secondary"}>
          {managedContainerStatus(resource, state)}
        </Badge>
        {resource.retained ? <Badge variant="secondary">Retained</Badge> : null}
        {shared ? (
          <Badge variant="secondary">{resource.references.length} thread references</Badge>
        ) : null}
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {resource.name} · {resource.containerId?.slice(0, 12) ?? "Creation pending"}
      </p>
      {resource.failure ? (
        <p className="text-xs text-muted-foreground">
          Last action failed: {resource.failure}. Refresh the inventory and ownership receipt before
          retrying.
        </p>
      ) : null}
      {resource.phase !== "released" ? (
        <div className="flex flex-wrap gap-2">
          {resource.phase === "ready" && !shared && state ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run(state === "running" ? "stop" : "start")}
            >
              {state === "running" ? "Stop" : "Start"}
            </Button>
          ) : null}
          {resource.phase === "pending" || resource.phase === "failed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run("retry")}
            >
              Recover creation
            </Button>
          ) : null}
          {actorId === resource.threadId ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void run(resource.retained ? "unretain" : "retain")}
            >
              {resource.retained ? "Clear retention" : "Retain"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="destructive"
            disabled={
              disabled ||
              resource.retained ||
              (shared && actorId === resource.threadId) ||
              resource.containerId === null
            }
            onClick={() => void run("release")}
          >
            {shared
              ? "Detach reference"
              : resource.phase === "releasing"
                ? "Retry release"
                : "Release container"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
