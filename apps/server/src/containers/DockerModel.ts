import type { ContainerAssociation, ContainerCounts } from "@t3tools/contracts";

export function parseDockerMemory(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)(?:\s*\/|\s*$)/.exec(
    value,
  );
  if (!match) return null;
  const units: Readonly<Record<string, number>> = {
    B: 1,
    kB: 1000,
    KB: 1000,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  return Number(match[1]) * units[match[2]!]!;
}

export function partitionContainers(
  containers: ReadonlyArray<{ readonly state: string; readonly health: string | null }>,
): ContainerCounts {
  const counts = {
    total: containers.length,
    running: 0,
    stopped: 0,
    paused: 0,
    restarting: 0,
    removing: 0,
    unknown: 0,
    unhealthy: 0,
  };
  for (const container of containers) {
    switch (container.state) {
      case "running":
        counts.running++;
        if (container.health === "unhealthy") counts.unhealthy++;
        break;
      case "created":
      case "exited":
      case "dead":
        counts.stopped++;
        break;
      case "paused":
        counts.paused++;
        break;
      case "restarting":
        counts.restarting++;
        break;
      case "removing":
        counts.removing++;
        break;
      default:
        counts.unknown++;
    }
  }
  return counts;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function composeStackKey(
  project: string | null,
  files: ReadonlyArray<string>,
): string | null {
  if (
    !project ||
    !files.length ||
    files.length > 64 ||
    files.some((file) => !file.startsWith("/") || file.length > 4096)
  )
    return null;
  const key = JSON.stringify([project, [...new Set(files)].sort()]);
  return key.length <= 8192 ? key : null;
}

/** Visibility links are evidence of a relationship, never ownership or permission to clean up. */
export function associateContainer(
  container: {
    readonly composePaths: ReadonlyArray<string>;
    readonly bindSources: ReadonlyArray<string>;
  },
  folders: ReadonlyArray<string>,
  includes: ReadonlyArray<string>,
  excludes: ReadonlyArray<string>,
): ReadonlyArray<ContainerAssociation> {
  const matches = new Map<string, ContainerAssociation>();
  const roots = [...folders].sort((left, right) => right.length - left.length);
  for (const [source, paths] of [
    ["compose", container.composePaths],
    ["mount", container.bindSources],
  ] as const) {
    for (const path of paths) {
      const folder = roots.find((root) => inside(root, path));
      if (folder && !excludes.includes(folder) && !matches.has(folder))
        matches.set(folder, { folder, source });
    }
  }
  for (const folder of includes) matches.set(folder, { folder, source: "manual" });
  return Array.from(matches.values());
}
