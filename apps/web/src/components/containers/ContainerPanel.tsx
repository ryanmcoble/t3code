import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type ContainerRecord,
  type ContainerSnapshot,
  type ContainerFolderRule,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  containerCountLabel,
  containerPanelSummary,
  containerMetricsLabel,
  groupContainers,
  containerRuleAvailability,
  resolveContainerFolders,
  type ContainerFilter,
} from "@t3tools/client-runtime/state/shared-capabilities";
import { useState, useSyncExternalStore } from "react";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { useProjects } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { type EnvironmentQueryView, useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ManagedContainerList } from "./ManagedContainerList";

function ContainerPanel({
  environmentId,
  folders,
  snapshot,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly folders?: ReadonlyArray<string>;
  readonly snapshot: EnvironmentQueryView<ContainerSnapshot>;
  readonly threadId?: ThreadId;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [limit, setLimit] = useState(40);
  const data = snapshot.data;
  const resolvedFolders = folders
    ? resolveContainerFolders(folders, data?.folderAliases ?? [])
    : undefined;
  const groups = groupContainers(data?.containers ?? [], {
    search,
    filter,
    ...(resolvedFolders ? { folders: resolvedFolders } : {}),
  });
  const shown = groups.flatMap((group) => group.containers).slice(0, limit);
  const linkedCount = data
    ? groupContainers(data.containers, {
        search: "",
        filter: "all",
        ...(resolvedFolders ? { folders: resolvedFolders } : {}),
      }).flatMap((group) => group.containers).length
    : null;
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {data && data.status !== "starting"
            ? folders
              ? `${linkedCount} linked containers`
              : containerCountLabel(data.counts)
            : "Checking Docker…"}
        </span>
        {data ? (
          <Badge variant={data.stale || !data.complete ? "warning" : "secondary"}>
            {data.status === "starting"
              ? "Checking"
              : data.stale
                ? "Stale"
                : data.complete
                  ? "Current"
                  : "Partial"}
          </Badge>
        ) : null}
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {snapshot.error ?? data?.message ?? "Connecting to this environment’s Docker engine…"}
        {data && data.sampledAt > 0
          ? ` Sampled ${new Date(data.sampledAt).toLocaleTimeString()}.`
          : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={snapshot.refresh}>
          Refresh inventory
        </Button>
        <Input
          aria-label="Search containers"
          placeholder="Search containers"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(40);
          }}
        />
        <Select
          value={filter}
          onValueChange={(value) => {
            if (
              value === "all" ||
              value === "running" ||
              value === "stopped" ||
              value === "unhealthy"
            ) {
              setFilter(value);
              setLimit(40);
            }
          }}
        >
          <SelectTrigger aria-label="Container status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {(["all", "running", "stopped", "unhealthy"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all" ? "All states" : value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {groups.map((group) => (
        <section key={group.key} className="space-y-1">
          <h4 className="break-all text-xs font-medium text-muted-foreground">
            {group.label} · {group.containers.length}
          </h4>
          {group.containers
            .filter((container) => shown.includes(container))
            .map((container) => (
              <ContainerRow
                key={container.id}
                environmentId={environmentId}
                engineId={data!.engineId!}
                container={container}
              />
            ))}
        </section>
      ))}
      {groups.reduce((count, group) => count + group.containers.length, 0) > limit ? (
        <Button variant="outline" size="sm" onClick={() => setLimit(limit + 40)}>
          Show more containers
        </Button>
      ) : null}
      {data ? (
        <ContainerRules
          environmentId={environmentId}
          snapshot={data}
          {...(resolvedFolders ? { folders: resolvedFolders } : {})}
        />
      ) : null}
      {data && data.status !== "starting" && !groups.length ? (
        <p className="text-sm text-muted-foreground">
          {folders
            ? "No containers linked to these folders. Open this environment’s container overview to link one."
            : data.containers.length
              ? "No containers match this filter."
              : data.status === "ready"
                ? "No containers on this Docker engine."
                : "Inventory is unavailable."}
        </p>
      ) : null}
      <ManagedContainerList
        environmentId={environmentId}
        {...(threadId ? { threadId } : {})}
        {...(data ? { snapshot: data } : {})}
      />
    </div>
  );
}

function ContainerRules({
  environmentId,
  snapshot,
  folders,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: ContainerSnapshot;
  readonly folders?: ReadonlyArray<string>;
}) {
  const allowed = useAtomValue(sharedCapabilities.containerAssociate.permissionAtom(environmentId));
  const associate = useAtomCommand(sharedCapabilities.containerAssociate, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const rules = (snapshot.associationRules ?? []).filter(
    (rule) => !folders || folders.includes(rule.folder),
  );
  const remove = async (rule: ContainerFolderRule) => {
    const result = await associate({
      environmentId,
      input: {
        engineId: rule.engineId,
        containerId: rule.containerId,
        folder: rule.folder,
        ruleId: rule.id,
        operation: "remove",
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The saved rule could not be removed.");
    } else setError(null);
  };
  if (!rules.length) return null;
  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Saved folder links and exclusions · {rules.length}
      </summary>
      <div className="space-y-2 pt-2">
        {rules.map((rule) => (
          <div
            key={`${rule.engineId}:${rule.id}:${rule.folder}`}
            className="flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <span className="break-all">
              {rule.label} · {rule.stackKey ? "Compose stack" : "Container"} ·{" "}
              {rule.rule === "exclude" ? "Excluded from" : "Linked to"} {rule.folder} ·{" "}
              {containerRuleAvailability(snapshot, rule)}
            </span>
            <Button size="sm" variant="ghost" disabled={!allowed} onClick={() => void remove(rule)}>
              {rule.rule === "exclude" ? "Remove exclusion" : "Unlink"}
            </Button>
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function ContainerRow({
  environmentId,
  engineId,
  container,
}: {
  readonly environmentId: EnvironmentId;
  readonly engineId: string;
  readonly container: ContainerRecord;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="border-b border-border py-2"
    >
      <summary className="cursor-pointer space-y-1 text-sm">
        <span className="font-medium">{container.name}</span>
        <span className="ml-2 text-muted-foreground">
          {container.state}
          {container.health
            ? ` · ${container.state === "running" ? "" : "last health: "}${container.health}`
            : ""}
        </span>
        <span className="block text-xs text-muted-foreground">
          {containerMetricsLabel(container)}
        </span>
      </summary>
      {expanded ? (
        <ContainerInspector
          environmentId={environmentId}
          engineId={engineId}
          container={container}
        />
      ) : null}
    </details>
  );
}

export function ContainerDisclosure({
  environmentId,
  label,
  folders,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly folders?: ReadonlyArray<string>;
  readonly threadId?: ThreadId;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cachedSummary, setCachedSummary] = useState("Expand to check Docker");
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const environment = useEnvironment(environmentId);
  const activity = useSyncExternalStore(
    subscribeDocumentActivity,
    getDocumentActivity,
    getDocumentActivity,
  );
  const supported = environment?.serverConfig?.environment.capabilities.containers === 1;
  const snapshot = useEnvironmentQuery(
    expanded && canRead && supported && activity.visible
      ? sharedCapabilities.containers({ environmentId, input: {} })
      : null,
  );
  return (
    <details
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!event.currentTarget.open && snapshot.data)
          setCachedSummary(containerPanelSummary(snapshot.data, folders));
        setExpanded(event.currentTarget.open);
      }}
      className="border-b border-border py-2"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {snapshot.data ? containerPanelSummary(snapshot.data, folders) : cachedSummary}
        </span>
      </summary>
      {expanded ? (
        !supported ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {environment?.serverConfig
              ? "Update this environment to view Docker containers."
              : "Waiting for this environment…"}
          </p>
        ) : !canRead ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            This connection needs diagnostics read access.
          </p>
        ) : (
          <ContainerPanel
            environmentId={environmentId}
            snapshot={snapshot}
            {...(threadId ? { threadId } : {})}
            {...(folders ? { folders } : {})}
          />
        )
      ) : null}
    </details>
  );
}

function ContainerInspector({
  environmentId,
  engineId,
  container,
}: {
  readonly environmentId: EnvironmentId;
  readonly engineId: string;
  readonly container: ContainerRecord;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [folder, setFolder] = useState<string | null>(null);
  const [scope, setScope] = useState<"container" | "stack">("container");
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const canAssociate = useAtomValue(
    sharedCapabilities.containerAssociate.permissionAtom(environmentId),
  );
  const associate = useAtomCommand(sharedCapabilities.containerAssociate, { reportFailure: false });
  const logs = useEnvironmentQuery(
    showLogs
      ? sharedCapabilities.containerLogs({
          environmentId,
          input: { engineId, containerId: container.id, lines: 200 },
        })
      : null,
  );
  const change = async (
    operation: "include" | "exclude" | "remove",
    target: string,
    ruleId?: string,
    targetScope: "container" | "stack" = "container",
  ) => {
    const result = await associate({
      environmentId,
      input: {
        engineId,
        containerId: container.id,
        folder: target,
        operation,
        scope: targetScope,
        ...(ruleId ? { ruleId } : {}),
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "The folder link could not be changed. Check access and refresh.",
      );
    } else setError(null);
  };
  return (
    <div className="space-y-3 pt-3 text-xs">
      <dl className="space-y-1 break-all">
        <dt className="text-muted-foreground">Image</dt>
        <dd>{container.image || "Unavailable"}</dd>
        <dt className="text-muted-foreground">Identity</dt>
        <dd>{container.id}</dd>
        <dt className="text-muted-foreground">Compose</dt>
        <dd>
          {[container.composeProject, container.composeService].filter(Boolean).join(" / ") ||
            "Not a Compose service"}
        </dd>
        <dt className="text-muted-foreground">Restarts</dt>
        <dd>{container.restartCount}</dd>
        <dt className="text-muted-foreground">Started / finished</dt>
        <dd>
          {container.startedAt ?? "Unknown"} / {container.finishedAt ?? "Not finished"}
        </dd>
        <dt className="text-muted-foreground">Compose paths</dt>
        <dd>{container.composePaths.join(", ") || "None"}</dd>
        <dt className="text-muted-foreground">Bind sources</dt>
        <dd>{container.bindSources.join(", ") || "None"}</dd>
        <dt className="text-muted-foreground">Published ports on this environment</dt>
        <dd>
          {container.ports
            .map(
              (port) => `${port.hostIp}:${port.hostPort} → ${port.containerPort}/${port.protocol}`,
            )
            .join(", ") || "None"}
        </dd>
      </dl>
      <p className="text-muted-foreground">
        Folder links describe related work. They do not make this container owned by a thread.
      </p>
      {container.associations.map((link) => (
        <div key={link.folder} className="flex flex-wrap items-center gap-2">
          <span className="break-all">
            {link.folder} · {link.source === "mount" ? "Related via mount" : link.source}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canAssociate}
            onClick={() =>
              void change(link.source === "manual" ? "remove" : "exclude", link.folder, link.ruleId)
            }
          >
            {link.source === "manual"
              ? link.scope === "stack"
                ? "Unlink stack"
                : "Unlink"
              : "Exclude match"}
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Select
          value={scope}
          onValueChange={(value) => {
            if (value === "container" || value === "stack") setScope(value);
          }}
        >
          <SelectTrigger aria-label="Container link scope">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="container">This container</SelectItem>
            <SelectItem value="stack" disabled={!container.stackKey}>
              Compose stack, including recreated containers
            </SelectItem>
          </SelectPopup>
        </Select>
        <Select value={folder} onValueChange={setFolder}>
          <SelectTrigger aria-label="Container project folder">
            <SelectValue placeholder="Choose a project folder" />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.workspaceRoot}>
                {project.title} · {project.workspaceRoot}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={!canAssociate || !folder}
          onClick={() => {
            if (folder) void change("include", folder, undefined, scope);
          }}
        >
          Link folder
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => setShowLogs(!showLogs)}>
        {showLogs ? "Close logs" : "Read recent logs"}
      </Button>
      {showLogs ? (
        <div className="space-y-2">
          <Button variant="ghost" size="sm" onClick={logs.refresh}>
            Refresh logs
          </Button>
          {logs.error ? <p role="alert">{logs.error}</p> : null}
          {logs.data?.truncated ? <p>Log output was truncated.</p> : null}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3">
            {logs.data?.text ?? "Loading recent logs…"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
