import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  copyProjectFolder,
  copyOrSyncProjectFolder,
  linkProjectFolders,
  syncProjectFolder,
} from "../../../../packages/client-runtime/src/operations/projectFolder.ts";
import { type AtomCommand } from "../../../../packages/client-runtime/src/state/runtime.ts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- Verifies binary contents, permissions and symlinks on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
const folderWatches = vi.hoisted(
  () => new Map<string, { changed: () => void; close: ReturnType<typeof vi.fn> }>(),
);
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    watch: (root: string, _options: unknown, listener: (event: string, name: string) => void) => {
      const close = vi.fn();
      const watcher = { close, unref: () => {}, on: () => watcher };
      folderWatches.set(root, { changed: () => listener("change", "nested/file"), close });
      return watcher;
    },
  };
});
import {
  EnvironmentId,
  ProjectFolderImportInput,
  PROJECT_FOLDER_CHUNK_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ProjectFolderTransfer from "./ProjectFolderTransfer.ts";

const decodeFolderImport = Schema.decodeUnknownSync(ProjectFolderImportInput);

const layer = ProjectFolderTransfer.layer.pipe(
  Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void })),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-folder-config-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-folder-test-" });
  const source = NodePath.join(root, "source");
  const destination = NodePath.join(root, "destination");
  yield* Effect.promise(() => NodeFSP.mkdir(source));
  return { root, source, destination, service: yield* ProjectFolderTransfer.ProjectFolderTransfer };
});

const commandAdapter =
  (requests: Queue.Queue<Effect.Effect<void>>) =>
  <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E>,
  ): AtomCommand<{ environmentId: EnvironmentId; input: I }, A, E> => ({
    label: "test folder operation",
    run: (_registry, { input }) =>
      new Promise((resolve) => {
        Queue.offerUnsafe(
          requests,
          Effect.exit(operation(input)).pipe(
            Effect.map((exit) => resolve(AsyncResult.fromExit(exit))),
          ),
        );
      }),
  });

describe("ProjectFolderTransfer", () => {
  it.effect(
    "copies binary chunks, hidden files, empty folders and executable files without changing the source",
    () =>
      Effect.gen(function* () {
        const { source, destination, service } = yield* fixture;
        const bytes = Buffer.alloc(PROJECT_FOLDER_CHUNK_BYTES * 3 + 123);
        bytes.forEach((_, index) => {
          bytes[index] = index % 251;
        });
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(source, "binary"), bytes);
          await NodeFSP.writeFile(NodePath.join(source, ".env"), "SECRET=value\n");
          await NodeFSP.mkdir(NodePath.join(source, "empty"));
          await NodeFSP.writeFile(NodePath.join(source, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
          if (symlinksSupported)
            await NodeFSP.symlink("run.sh", NodePath.join(source, "linked-script"));
        });
        const exported = yield* service.exportFolder({ cwd: source });
        const imported = yield* service.importFolder({
          destinationPath: destination,
          entries: exported.entries,
        });
        for (const entry of exported.entries.filter((entry) => entry.kind === "file")) {
          const offsets = Array.from(
            { length: Math.ceil(entry.byteLength / PROJECT_FOLDER_CHUNK_BYTES) },
            (_, index) => index * PROJECT_FOLDER_CHUNK_BYTES,
          ).reverse();
          for (const offset of offsets) {
            const chunk = yield* service.read({
              transferId: exported.transferId,
              relativePath: entry.path,
              offset,
            });
            yield* service.write({
              transferId: imported.transferId,
              relativePath: entry.path,
              offset,
              contents: chunk.contents,
            });
            expect(
              (yield* service
                .write({
                  transferId: imported.transferId,
                  relativePath: entry.path,
                  offset,
                  contents: chunk.contents,
                })
                .pipe(Effect.flip)).reason,
            ).toBe("invalid_chunk");
          }
        }
        expect(yield* service.finish(imported)).toEqual({ cwd: destination });
        const platform = yield* HostProcess.Platform;
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(destination, "binary"))).toEqual(bytes);
          expect(await NodeFSP.readFile(NodePath.join(source, "binary"))).toEqual(bytes);
          expect(await NodeFSP.readFile(NodePath.join(destination, ".env"), "utf8")).toBe(
            "SECRET=value\n",
          );
          if (symlinksSupported)
            expect(await NodeFSP.readlink(NodePath.join(destination, "linked-script"))).toBe(
              "run.sh",
            );
          expect((await NodeFSP.stat(NodePath.join(destination, "empty"))).isDirectory()).toBe(
            true,
          );
          if (platform !== "win32")
            expect((await NodeFSP.stat(NodePath.join(destination, "run.sh"))).mode & 0o777).toBe(
              0o755,
            );
        });
        yield* service.cancel(exported);
        if (symlinksSupported) {
          yield* Effect.promise(() =>
            NodeFSP.symlink(destination, NodePath.join(source, "external")),
          );
          expect((yield* service.exportFolder({ cwd: source }).pipe(Effect.flip)).reason).toBe(
            "unsupported_entry",
          );
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("accepts transfers beyond the former size and entry-count caps", () =>
    Effect.gen(function* () {
      const { source, destination, service } = yield* fixture;
      yield* Effect.forEach(
        Array.from({ length: 10_001 }, (_, index) => `folder-${index}`),
        (name) => Effect.promise(() => NodeFSP.mkdir(NodePath.join(source, name))),
        { concurrency: 32, discard: true },
      );
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(source, "large-file"), "");
        await NodeFSP.truncate(NodePath.join(source, "large-file"), 1024 ** 3 + 1);
      });
      const exported = yield* service.exportFolder({ cwd: source });
      expect(exported.entries).toHaveLength(10_002);
      expect(exported.entries.find((entry) => entry.path === "large-file")?.byteLength).toBe(
        1024 ** 3 + 1,
      );
      const imported = yield* service.importFolder(
        decodeFolderImport({ destinationPath: destination, entries: exported.entries }),
      );
      yield* service.cancel(exported);
      yield* service.cancel(imported);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects escaping paths, links and collisions before creating a destination", () =>
    Effect.gen(function* () {
      const { destination, service } = yield* fixture;
      const file = { kind: "file" as const, mode: 0o644, byteLength: 0 };
      for (const entries of [
        [{ ...file, path: "../escape" }],
        [{ ...file, path: "C:/escape" }],
        [
          { ...file, path: "a" },
          { ...file, path: "A" },
        ],
        [{ ...file, path: "a/b" }],
        [{ ...file, kind: "symlink" as const, path: "link", linkTarget: "../escape" }],
      ])
        expect(
          (yield* service.importFolder({ destinationPath: destination, entries }).pipe(Effect.flip))
            ._tag,
        ).toBe("ProjectFolderTransferError");
      expect(yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(destination)))).toEqual([
        "source",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "rejects missing and out-of-order chunks, cleans cancellation, and never overwrites a destination",
    () =>
      Effect.gen(function* () {
        const { source, destination, service } = yield* fixture;
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(source, "file"), "abc"));
        const exported = yield* service.exportFolder({ cwd: source });
        const imported = yield* service.importFolder({
          destinationPath: destination,
          entries: exported.entries,
        });
        expect((yield* service.finish(imported).pipe(Effect.flip)).reason).toBe("incomplete");
        expect(
          (yield* service
            .write({ ...imported, relativePath: "file", offset: 1, contents: "YQ==" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_chunk");
        yield* service.write({ ...imported, relativePath: "file", offset: 0, contents: "YWJj" });
        yield* Effect.promise(() => NodeFSP.mkdir(destination));
        expect((yield* service.finish(imported).pipe(Effect.flip)).reason).toBe(
          "destination_exists",
        );
        yield* service.cancel(imported);
        expect((yield* service.finish(imported).pipe(Effect.flip)).reason).toBe("invalid_session");
        expect(yield* Effect.promise(() => NodeFSP.readdir(destination))).toEqual([]);
        expect(yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(destination)))).toEqual(
          ["destination", "source"],
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses a file changed after export planning", () =>
    Effect.gen(function* () {
      const { source, service } = yield* fixture;
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(source, "file"), "abc"));
      const exported = yield* service.exportFolder({ cwd: source });
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(source, "file"), "changed"));
      expect(
        (yield* service.read({ ...exported, relativePath: "file", offset: 0 }).pipe(Effect.flip))
          .reason,
      ).toBe("source_changed");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect(
    "sync stages a replacement, propagates deletions, and retains unchanged local bytes",
    () =>
      Effect.gen(function* () {
        const { source, destination, service } = yield* fixture;
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(source, "keep"), "abc");
          await NodeFSP.writeFile(NodePath.join(source, "delete"), "old");
        });
        const before = yield* service.exportFolder({ cwd: source });
        const keep = before.entries.find((entry) => entry.path === "keep")!;
        const staged = yield* service.importFolder({
          destinationPath: source,
          previousEntries: before.entries,
          entries: [keep],
        });
        expect(yield* service.finish(staged)).toEqual({ cwd: source });
        expect(yield* Effect.promise(() => NodeFSP.readdir(source))).toEqual(["keep"]);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(source, "keep"), "utf8")),
        ).toBe("abc");
        const current = yield* service.exportFolder({ cwd: source });
        const another = yield* service.importFolder({
          destinationPath: source,
          previousEntries: current.entries,
          entries: [],
        });
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(source, "keep"), "new work"));
        expect((yield* service.finish(another).pipe(Effect.flip)).reason).toBe("source_changed");
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(source, "keep"), "utf8")),
        ).toBe("new work");
        yield* service.cancel(another);
        const corrupt = yield* service.importFolder({
          destinationPath: destination,
          entries: [keep],
        });
        yield* service.write({ ...corrupt, relativePath: "keep", offset: 0, contents: "YmFk" });
        expect((yield* service.finish(corrupt).pipe(Effect.flip)).reason).toBe("invalid_chunk");
        yield* service.cancel(corrupt);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "tracks nested edits, reattaches after folder replacement, and closes watches on unlink",
    () =>
      Effect.gen(function* () {
        folderWatches.clear();
        const { source, root, service } = yield* fixture;
        const state = {
          peerEnvironmentId: EnvironmentId.make("peer"),
          peerPath: "/peer",
          baseline: [],
          automatic: true,
        };
        yield* service.setSync({ cwd: source, state });
        const first = yield* service.status({ cwd: source });
        const watch = folderWatches.get(first.cwd)!;
        watch.changed();
        const changed = yield* service.status({ cwd: source });
        expect(changed.revision).not.toBe(first.revision);
        expect(changed.sync).not.toHaveProperty("baseline");
        yield* Effect.promise(async () => {
          await NodeFSP.rename(source, NodePath.join(root, "old"));
          await NodeFSP.mkdir(source);
        });
        const replaced = yield* service.status({ cwd: source });
        expect(replaced.revision).not.toBe(changed.revision);
        expect(watch.close).toHaveBeenCalledOnce();
        const replacement = folderWatches.get(first.cwd)!;
        yield* service.setSync({ cwd: source, state: null });
        expect(replacement.close).toHaveBeenCalledOnce();
        expect((yield* service.status({ cwd: source })).sync).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "links differing existing copies without overwriting them or choosing an unsafe baseline",
    () =>
      Effect.gen(function* () {
        const { source, destination, service } = yield* fixture;
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const requests = yield* Queue.unbounded<Effect.Effect<void>>();
        yield* Queue.take(requests).pipe(
          Effect.flatMap((request) => request),
          Effect.forever,
          Effect.forkChild,
        );
        const command = commandAdapter(requests);
        const commands = {
          folderStatus: command(service.status),
          folderExport: command(service.exportFolder),
          folderExportEnd: command(service.exportEnd),
          folderImport: command(service.importFolder),
          folderRead: command(service.read),
          folderWrite: command(service.write),
          folderFinish: command(service.finish),
          folderCancel: command(service.cancel),
          folderSyncSet: command(service.setSync),
          folderSyncGet: ({ input }: { environmentId: EnvironmentId; input: { cwd: string } }) =>
            Atom.make(service.getSync(input)),
        };
        const local = { environmentId: EnvironmentId.make("local"), cwd: source };
        const remote = { environmentId: EnvironmentId.make("remote"), cwd: destination };
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(destination);
          for (const folder of [source, destination])
            await NodeFSP.writeFile(NodePath.join(folder, "same"), "same");
          await NodeFSP.writeFile(NodePath.join(source, "different"), "local work");
          await NodeFSP.writeFile(NodePath.join(destination, "different"), "remote work");
        });
        yield* Effect.promise(() =>
          linkProjectFolders(registry, commands, local, remote, {
            automatic: true,
            coordinatorEnvironmentId: local.environmentId,
          }),
        );
        const state = (yield* service.getSync(local))!;
        expect(state.baseline.map((entry) => entry.path)).toEqual(["same"]);
        expect(state.automatic).toBe(true);
        yield* Effect.promise(async () => {
          await expect(syncProjectFolder(registry, commands, local, state)).rejects.toThrow(
            "Both folders changed",
          );
          expect(await NodeFSP.readFile(NodePath.join(source, "different"), "utf8")).toBe(
            "local work",
          );
          expect(await NodeFSP.readFile(NodePath.join(destination, "different"), "utf8")).toBe(
            "remote work",
          );
        });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stores and removes a folder sync baseline outside the project", () =>
    Effect.gen(function* () {
      const { source, service } = yield* fixture;
      expect(yield* service.getSync({ cwd: source })).toBeNull();
      const state = {
        peerEnvironmentId: EnvironmentId.make("peer"),
        peerPath: "/peer/folder",
        baseline: [],
      };
      yield* service.setSync({ cwd: source, state });
      expect(yield* service.getSync({ cwd: source })).toEqual(state);
      expect(yield* Effect.promise(() => NodeFSP.readdir(source))).toEqual([]);
      yield* service.setSync({ cwd: source, state: null });
      expect(yield* service.getSync({ cwd: source })).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect(
    "copies and then synchronizes two folders through the client workflow, including deletions and conflicts",
    () =>
      Effect.gen(function* () {
        const { source, destination, service } = yield* fixture;
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const requests = yield* Queue.unbounded<Effect.Effect<void>>();
        yield* Queue.take(requests).pipe(
          Effect.flatMap((request) => request),
          Effect.forever,
          Effect.forkChild,
        );
        const command = commandAdapter(requests);
        const commands = {
          folderStatus: command(service.status),
          folderExport: command(service.exportFolder),
          folderExportEnd: command(service.exportEnd),
          folderImport: command(service.importFolder),
          folderRead: command(service.read),
          folderWrite: command(service.write),
          folderFinish: command(service.finish),
          folderCancel: command(service.cancel),
          folderSyncSet: command(service.setSync),
          folderSyncGet: ({ input }: { environmentId: EnvironmentId; input: { cwd: string } }) =>
            Atom.make(service.getSync(input)),
        };
        const local = { environmentId: EnvironmentId.make("local"), cwd: source };
        const remote = { environmentId: EnvironmentId.make("remote"), cwd: destination };
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(source, "local"), "old");
          await NodeFSP.writeFile(NodePath.join(source, "remote"), "old");
          await NodeFSP.writeFile(NodePath.join(source, "delete"), "old");
        });
        yield* Effect.promise(() =>
          copyProjectFolder(registry, commands, {
            source: local,
            targetEnvironmentId: remote.environmentId,
            destinationPath: destination,
          }),
        );
        // Moving a thread to an existing copy must not copy or synchronize its files.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(destination, "remote-only"), "keep"),
        );
        expect(
          yield* Effect.promise(() =>
            copyOrSyncProjectFolder(registry, commands, {
              source: local,
              targetEnvironmentId: remote.environmentId,
              destinationPath: destination,
              reuseExisting: true,
            }),
          ),
        ).toEqual({
          cwd: yield* Effect.promise(() => NodeFSP.realpath(destination)),
          reused: true,
        });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(destination, "remote-only"), "utf8"),
          ),
        ).toBe("keep");
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(destination, "remote-only")));
        yield* Effect.promise(() => linkProjectFolders(registry, commands, local, remote));
        const state = (yield* service.getSync(local))!;
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(source, "local"), "local edit");
          await NodeFSP.writeFile(NodePath.join(destination, "remote"), "remote edit");
          await NodeFSP.rm(NodePath.join(destination, "delete"));
        });
        expect(
          yield* Effect.promise(() =>
            copyOrSyncProjectFolder(registry, commands, {
              source: local,
              targetEnvironmentId: remote.environmentId,
              destinationPath: destination,
            }),
          ),
        ).toEqual({ cwd: destination, reused: true });
        yield* Effect.promise(async () => {
          for (const folder of [source, destination]) {
            expect(await NodeFSP.readdir(folder)).toEqual(["local", "remote"]);
            expect(await NodeFSP.readFile(NodePath.join(folder, "local"), "utf8")).toBe(
              "local edit",
            );
            expect(await NodeFSP.readFile(NodePath.join(folder, "remote"), "utf8")).toBe(
              "remote edit",
            );
          }
          await NodeFSP.writeFile(NodePath.join(source, "local"), "first version");
          await NodeFSP.writeFile(NodePath.join(destination, "local"), "second version");
          await expect(syncProjectFolder(registry, commands, local, state)).rejects.toThrow(
            "Both folders changed",
          );
          expect(await NodeFSP.readFile(NodePath.join(source, "local"), "utf8")).toBe(
            "first version",
          );
          expect(await NodeFSP.readFile(NodePath.join(destination, "local"), "utf8")).toBe(
            "second version",
          );
        });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
