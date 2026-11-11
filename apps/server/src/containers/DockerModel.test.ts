import { describe, expect, it } from "vite-plus/test";
import {
  associateContainer,
  composeStackKey,
  parseDockerMemory,
  partitionContainers,
} from "./DockerModel.ts";

describe("Docker inventory interpretation", () => {
  it("requires a proven Compose configuration set and preserves its identity across ordering changes", () => {
    expect(composeStackKey("api", [])).toBeNull();
    expect(composeStackKey(null, ["/repo/compose.yaml"])).toBeNull();
    expect(composeStackKey("api", ["relative.yaml"])).toBeNull();
    expect(composeStackKey("api", ["/repo/a.yaml", "/repo/b.yaml"])).toBe(
      composeStackKey("api", ["/repo/b.yaml", "/repo/a.yaml"]),
    );
    expect(composeStackKey("api", ["/repo/a.yaml"])).not.toBe(
      composeStackKey("api", ["/other/a.yaml"]),
    );
  });
  it("keeps missing metrics unknown and uses Docker binary memory units", () => {
    expect(parseDockerMemory("12.5MiB / 8GiB")).toBe(13_107_200);
    expect(parseDockerMemory("1.5GB / 16GB")).toBe(1_500_000_000);
    expect(parseDockerMemory("--")).toBeNull();
    expect(parseDockerMemory("not available")).toBeNull();
  });

  it("partitions physical containers once and excludes stopped stale health", () => {
    expect(
      partitionContainers([
        { state: "running", health: "unhealthy" },
        { state: "exited", health: "unhealthy" },
        { state: "paused", health: null },
        { state: "restarting", health: null },
        { state: "removing", health: null },
        { state: "created", health: null },
        { state: "future-state", health: null },
      ]),
    ).toEqual({
      total: 7,
      running: 1,
      stopped: 2,
      paused: 1,
      restarting: 1,
      removing: 1,
      unknown: 1,
      unhealthy: 1,
    });
  });

  it("matches folder boundaries, most specific roots and shared mounts without claiming ownership", () => {
    const folders = ["/repo/app", "/repo/apple", "/repo/app/nested", "/other"];
    expect(
      associateContainer(
        { composePaths: ["/repo/app/nested/compose.yaml"], bindSources: ["/repo"] },
        folders,
        [],
        [],
      ),
    ).toEqual([{ folder: "/repo/app/nested", source: "compose" }]);
    expect(
      associateContainer(
        { composePaths: [], bindSources: ["/repo/app/src", "/other/code"] },
        folders,
        [],
        [],
      ),
    ).toEqual([
      { folder: "/repo/app", source: "mount" },
      { folder: "/other", source: "mount" },
    ]);
    expect(
      associateContainer(
        { composePaths: [], bindSources: ["/repo", "/repo/apples"] },
        folders,
        [],
        [],
      ),
    ).toEqual([]);
    expect(
      associateContainer(
        { composePaths: ["/repo/app/compose.yaml"], bindSources: [] },
        folders,
        ["/other"],
        ["/repo/app"],
      ),
    ).toEqual([{ folder: "/other", source: "manual" }]);
  });
});
