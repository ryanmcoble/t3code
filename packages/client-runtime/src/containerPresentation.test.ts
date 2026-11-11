import { describe, expect, it } from "vite-plus/test";
import type { ContainerRecord } from "@t3tools/contracts";
import {
  groupContainers,
  resolveContainerFolders,
  managedContainerStatus,
} from "./containerPresentation.ts";

const record: ContainerRecord = {
  id: "a".repeat(64),
  name: "api",
  image: "acme/api",
  available: true,
  state: "running",
  health: "unhealthy",
  restartCount: 0,
  startedAt: null,
  finishedAt: null,
  composeProject: null,
  composeService: null,
  composePaths: [],
  bindSources: [],
  ports: [],
  cpuPercent: null,
  memoryBytes: null,
  associations: [],
};
describe("container groups", () => {
  it("keeps ownership phase distinct from observed container state", () => {
    expect(managedContainerStatus({ phase: "ready", failure: null }, undefined)).toBe(
      "Status unavailable",
    );
    expect(managedContainerStatus({ phase: "ready", failure: null }, "created")).toBe(
      "Not started",
    );
    expect(managedContainerStatus({ phase: "ready", failure: null }, "exited")).toBe("Stopped");
    expect(managedContainerStatus({ phase: "released", failure: null }, "running")).toBe(
      "Released",
    );
    expect(managedContainerStatus({ phase: "ready", failure: "unavailable" }, "running")).toBe(
      "Action failed",
    );
  });
  it("uses server-resolved root aliases without confusing sibling path prefixes", () => {
    expect(
      resolveContainerFolders(
        ["/work/api", "/work/api/sub", "/work/apix"],
        [{ path: "/work/api", canonicalPath: "/real/api" }],
      ),
    ).toEqual(["/real/api", "/real/api/sub", "/work/apix"]);
  });
  it("partitions shared and unassigned containers without inflating physical counts", () => {
    const groups = groupContainers(
      [
        {
          ...record,
          associations: [
            { folder: "/a", source: "mount" },
            { folder: "/b", source: "manual" },
          ],
        },
        { ...record, id: "b".repeat(64), name: "db" },
        { ...record, id: "c".repeat(64), associations: [{ folder: "/a", source: "compose" }] },
      ],
      { search: "", filter: "all" },
    );
    expect(groups.map((group) => [group.key, group.containers.length])).toEqual([
      ["folder:/a", 1],
      ["shared", 1],
      ["unassigned", 1],
    ]);
    expect(groups.flatMap((group) => group.containers)).toHaveLength(3);
  });
  it("filters exact thread folders and excludes stopped stale health without changing inventory", () => {
    const containers = [
      record,
      { ...record, state: "exited", associations: [{ folder: "/a", source: "compose" as const }] },
    ];
    expect(
      groupContainers(containers, { search: "", filter: "unhealthy" }).flatMap(
        (group) => group.containers,
      ),
    ).toEqual([record]);
    expect(groupContainers(containers, { search: "", filter: "all", folders: ["/apple"] })).toEqual(
      [],
    );
    expect(
      groupContainers(containers, { search: "API", filter: "stopped", folders: ["/a"] }).flatMap(
        (group) => group.containers,
      ),
    ).toHaveLength(1);
  });
});
