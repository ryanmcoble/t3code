import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, PROJECT_FOLDER_CHUNK_BYTES } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import { copyProjectFolder } from "./projectFolder.ts";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(parallelChunks: boolean) {
  const registry = AtomRegistry.make();
  const started = gate();
  const reads = gate();
  let active = 0;
  let maximum = 0;
  let finished = false;
  let cancelled = false;
  const offsets: number[] = [];
  const entry = {
    path: "large.bin",
    kind: "file" as const,
    mode: 0o644,
    byteLength: PROJECT_FOLDER_CHUNK_BYTES * 12 + 7,
  };
  const command = <I, A>(operation: (input: I) => A | Promise<A>) => ({
    label: "folder transfer fixture",
    run: async (_registry: AtomRegistry.AtomRegistry, { input }: { input: I }) =>
      AsyncResult.success(await operation(input)),
  });
  const commands = {
    folderStatus: command(() => ({
      exists: false,
      cwd: "/target",
      revision: "missing",
      sync: null,
    })),
    folderExport: command(() => ({ transferId: "source", entries: [entry] })),
    folderImport: command(() => ({
      transferId: "target",
      ...(parallelChunks ? { parallelChunks: true } : {}),
    })),
    folderRead: command(async ({ offset }: { offset: number }) => {
      active++;
      maximum = Math.max(maximum, active);
      started.release();
      await reads.promise;
      active--;
      return {
        contents: Buffer.alloc(
          Math.min(PROJECT_FOLDER_CHUNK_BYTES, entry.byteLength - offset),
        ).toString("base64"),
      };
    }),
    folderWrite: command(({ offset }: { offset: number }) => {
      offsets.push(offset);
    }),
    folderFinish: command(() => {
      finished = true;
      return { cwd: "/target" };
    }),
    folderCancel: command(() => {
      cancelled = true;
    }),
    folderExportEnd: command(() => {}),
    folderSyncSet: command(() => {}),
    folderSyncGet: () => {
      throw new Error("Unused sync query");
    },
  };
  return {
    registry,
    started,
    reads,
    commands,
    offsets,
    entry,
    get active() {
      return active;
    },
    get maximum() {
      return maximum;
    },
    get finished() {
      return finished;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe("folder transfer pipeline", () => {
  it("bounds outstanding chunks in one large file and falls back for older servers", async () => {
    for (const parallel of [true, false]) {
      const f = fixture(parallel);
      const progress: number[] = [];
      const copy = copyProjectFolder(f.registry, f.commands, {
        source: { environmentId: EnvironmentId.make("source"), cwd: "/source" },
        targetEnvironmentId: EnvironmentId.make("target"),
        destinationPath: "/target",
        onProgress: (copied) => progress.push(copied),
      });
      try {
        await f.started.promise;
        expect(f.active).toBe(parallel ? 8 : 1);
      } finally {
        f.reads.release();
        await copy;
        f.registry.dispose();
      }
      expect(f.maximum).toBe(parallel ? 8 : 1);
      expect(f.offsets.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 13 }, (_, index) => index * PROJECT_FOLDER_CHUNK_BYTES),
      );
      expect(progress.at(-1)).toBe(f.entry.byteLength);
      expect(f.finished).toBe(true);
    }
  });

  it("drains outstanding reads before cleaning a cancelled transfer", async () => {
    const f = fixture(true);
    const controller = new AbortController();
    const copy = copyProjectFolder(f.registry, f.commands, {
      source: { environmentId: EnvironmentId.make("source"), cwd: "/source" },
      targetEnvironmentId: EnvironmentId.make("target"),
      destinationPath: "/target",
      signal: controller.signal,
    });
    const rejected = expect(copy).rejects.toThrow("cancelled");
    await f.started.promise;
    controller.abort(new Error("cancelled"));
    expect(f.cancelled).toBe(false);
    f.reads.release();
    await rejected;
    expect(f.active).toBe(0);
    expect(f.offsets).toEqual([]);
    expect(f.finished).toBe(false);
    expect(f.cancelled).toBe(true);
    f.registry.dispose();
  });
});
