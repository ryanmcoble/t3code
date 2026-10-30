import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ProjectFolderEntry } from "@t3tools/contracts";

import { findFolderSyncProject, planFolderSync } from "./projectFolderSync.ts";

const file = (path: string, hash: string): ProjectFolderEntry => ({
  path,
  hash,
  kind: "file",
  mode: 0o644,
  byteLength: 3,
});

describe("planFolderSync", () => {
  it("identifies a synced project by its machine and exact folder instead of its title", () => {
    const projects = [
      { environmentId: EnvironmentId.make("other"), workspaceRoot: "/remote/Crypto" },
      { environmentId: EnvironmentId.make("peer"), workspaceRoot: "/unrelated/Crypto" },
      { environmentId: EnvironmentId.make("peer"), workspaceRoot: "/remote/Crypto/" },
    ];
    expect(
      findFolderSyncProject(projects, {
        peerEnvironmentId: EnvironmentId.make("peer"),
        peerPath: "/remote/Crypto",
        baseline: [],
      }),
    ).toBe(projects[2]);
    expect(findFolderSyncProject(projects, null)).toBeUndefined();
  });
  it("merges independent edits and propagates deletions in either direction", () => {
    const a = file("a", "old");
    const b = file("b", "old");
    const c = file("c", "old");
    const d = file("d", "old");
    const result = planFolderSync(
      [a, b, c, d],
      [file("a", "local"), b, c],
      [a, file("b", "remote"), d],
    );
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual([
      { entry: file("a", "local"), source: "local" },
      { entry: file("b", "remote"), source: "remote" },
    ]);
  });

  it("preserves edit/edit, delete/edit and directory replacement conflicts", () => {
    const old = file("file", "old");
    expect(planFolderSync([old], [file("file", "a")], [file("file", "b")]).conflicts).toEqual([
      "file",
    ]);
    expect(planFolderSync([old], [], [file("file", "b")]).conflicts).toEqual(["file"]);
    const directory: ProjectFolderEntry = {
      path: "dir",
      kind: "directory",
      mode: 0o755,
      byteLength: 0,
    };
    expect(
      planFolderSync([directory], [file("dir", "new")], [directory, file("dir/new", "new")])
        .conflicts,
    ).toEqual(["dir"]);
  });

  it("accepts matching concurrent changes and rejects case collisions across machines", () => {
    const old = file("file", "old");
    const changed = file("file", "same");
    expect(planFolderSync([old], [changed], [changed])).toEqual({
      merged: [{ entry: changed, source: "local" }],
      conflicts: [],
    });
    expect(planFolderSync([], [file("Foo", "a")], [file("foo", "b")]).conflicts).toEqual([
      "Foo",
      "foo",
    ]);
  });
});
