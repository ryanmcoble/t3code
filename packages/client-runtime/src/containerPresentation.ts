import * as DateTime from "effect/DateTime";
import type { ContainerFolderRule, ContainerRecord, ContainerSnapshot } from "@t3tools/contracts";

export type ContainerFilter = "all" | "running" | "stopped" | "unhealthy";
export interface ContainerGroup {
  readonly key: string;
  readonly label: string;
  readonly containers: ReadonlyArray<ContainerRecord>;
}

/** Each physical container appears once, even when several projects use it. */
export function groupContainers(
  containers: ReadonlyArray<ContainerRecord>,
  options: {
    readonly search: string;
    readonly filter: ContainerFilter;
    readonly folders?: ReadonlyArray<string>;
  },
): ReadonlyArray<ContainerGroup> {
  const search = options.search.trim().toLowerCase();
  const groups = new Map<string, ContainerRecord[]>();
  for (const container of containers) {
    if (
      options.folders &&
      !container.associations.some((link) => options.folders!.includes(link.folder))
    )
      continue;
    if (
      search &&
      !`${container.name} ${container.image} ${container.composeProject ?? ""} ${container.composeService ?? ""}`
        .toLowerCase()
        .includes(search)
    )
      continue;
    if (options.filter === "running" && container.state !== "running") continue;
    if (options.filter === "stopped" && !["created", "exited", "dead"].includes(container.state))
      continue;
    if (
      options.filter === "unhealthy" &&
      !(container.state === "running" && container.health === "unhealthy")
    )
      continue;
    const folders = [...new Set(container.associations.map((link) => link.folder))];
    const key = folders.length > 1 ? "shared" : folders[0] ? `folder:${folders[0]}` : "unassigned";
    const items = groups.get(key) ?? [];
    items.push(container);
    groups.set(key, items);
  }
  return Array.from(groups, ([key, items]) => ({
    key,
    label:
      key === "shared"
        ? "Shared across projects"
        : key === "unassigned"
          ? "Unassigned"
          : key.slice(7),
    containers: items.sort((left, right) => left.name.localeCompare(right.name)),
  })).sort((left, right) =>
    left.key === "unassigned"
      ? 1
      : right.key === "unassigned"
        ? -1
        : left.label.localeCompare(right.label),
  );
}

export function containerCountLabel(counts: ContainerSnapshot["counts"]): string {
  const parts = [`${counts.running} running`, `${counts.stopped} stopped`];
  for (const state of ["paused", "restarting", "removing", "unknown", "unhealthy"] as const)
    if (counts[state]) parts.push(`${counts[state]} ${state}`);
  return parts.join(" · ");
}

export function containerPanelSummary(
  snapshot: ContainerSnapshot,
  folders?: ReadonlyArray<string>,
): string {
  if (snapshot.status === "starting") return snapshot.message;
  const count = folders
    ? `${groupContainers(snapshot.containers, { search: "", filter: "all", folders: resolveContainerFolders(folders, snapshot.folderAliases ?? []) }).flatMap((group) => group.containers).length} linked containers`
    : containerCountLabel(snapshot.counts);
  return `${count} · ${snapshot.stale ? "Cached" : "Sampled"} ${DateTime.formatLocal(DateTime.makeUnsafe(snapshot.sampledAt), { timeStyle: "medium" })}`;
}

export function containerMetricsLabel(container: ContainerRecord): string {
  const cpu =
    container.cpuPercent === null ? "CPU unavailable" : `${container.cpuPercent.toFixed(1)}% CPU`;
  const bytes = container.memoryBytes;
  const memory =
    bytes === null
      ? "Memory unavailable"
      : bytes >= 1024 ** 3
        ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
        : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${cpu} · ${memory}`;
}

export function containerRuleAvailability(
  snapshot: ContainerSnapshot,
  rule: ContainerFolderRule,
): "available" | "unavailable" | "unknown" {
  if (snapshot.stale) return "unknown";
  if (snapshot.engineId !== rule.engineId) return "unavailable";
  const container = snapshot.containers.find((entry) =>
    rule.stackKey ? entry.stackKey === rule.stackKey : entry.id === rule.containerId,
  );
  if (container) return container.available ? "available" : "unknown";
  return snapshot.complete ? "unavailable" : "unknown";
}

/** Root aliases are resolved by the owning server, including registered worktrees and symlinks. */
export function resolveContainerFolders(
  folders: ReadonlyArray<string>,
  aliases: NonNullable<ContainerSnapshot["folderAliases"]>,
): ReadonlyArray<string> {
  return [
    ...new Set(
      folders.map((folder) => {
        const source = folder.replace(/\/+$/, "");
        const alias = [...aliases]
          .sort((left, right) => right.path.length - left.path.length)
          .find(
            (entry) =>
              source === entry.path.replace(/\/+$/, "") ||
              source.startsWith(`${entry.path.replace(/\/+$/, "")}/`),
          );
        return alias
          ? `${alias.canonicalPath.replace(/\/+$/, "")}${source.slice(alias.path.replace(/\/+$/, "").length)}`
          : source;
      }),
    ),
  ];
}
