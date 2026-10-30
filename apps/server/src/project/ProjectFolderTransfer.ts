// @effect-diagnostics nodeBuiltinImport:off -- Chunked binary I/O needs no-follow opens and exclusive destination creation.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";

import {
  PROJECT_FOLDER_CHUNK_BYTES,
  ProjectFolderTransferError,
  ProjectFolderSyncState,
  type ProjectFolderStatusResult,
  type ProjectFolderEntry,
  type ProjectFolderExportInput,
  type ProjectFolderExportResult,
  type ProjectFolderImportInput,
  type ProjectFolderImportResult,
  type ProjectFolderReadInput,
  type ProjectFolderWriteInput,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

interface Transfer {
  readonly kind: "export" | "import";
  readonly root: string;
  readonly destination: string | null;
  readonly entries: ReadonlyArray<ProjectFolderEntry>;
  readonly entriesByPath: ReadonlyMap<string, ProjectFolderEntry>;
  readonly offsets: Map<string, number>;
  readonly pendingOffsets: Map<string, Set<number>>;
  readonly modified: Map<string, number>;
  readonly previousEntries?: ReadonlyArray<ProjectFolderEntry>;
  readonly incremental?: boolean;
  touchedAt: number;
}

export class ProjectFolderTransfer extends Context.Service<
  ProjectFolderTransfer,
  {
    readonly status: (input: {
      cwd: string;
    }) => Effect.Effect<ProjectFolderStatusResult, ProjectFolderTransferError>;
    readonly getSync: (input: {
      cwd: string;
    }) => Effect.Effect<ProjectFolderSyncState | null, ProjectFolderTransferError>;
    readonly setSync: (input: {
      cwd: string;
      state: ProjectFolderSyncState | null;
    }) => Effect.Effect<void, ProjectFolderTransferError>;
    readonly exportEnd: (input: {
      transferId: string;
      validate: boolean;
    }) => Effect.Effect<void, ProjectFolderTransferError>;
    readonly exportFolder: (
      input: typeof ProjectFolderExportInput.Type,
    ) => Effect.Effect<typeof ProjectFolderExportResult.Type, ProjectFolderTransferError>;
    readonly importFolder: (
      input: typeof ProjectFolderImportInput.Type,
    ) => Effect.Effect<typeof ProjectFolderImportResult.Type, ProjectFolderTransferError>;
    readonly read: (
      input: typeof ProjectFolderReadInput.Type,
    ) => Effect.Effect<{ contents: string }, ProjectFolderTransferError>;
    readonly write: (
      input: typeof ProjectFolderWriteInput.Type,
    ) => Effect.Effect<void, ProjectFolderTransferError>;
    readonly finish: (input: {
      transferId: string;
    }) => Effect.Effect<{ cwd: string }, ProjectFolderTransferError>;
    readonly cancel: (input: {
      transferId: string;
    }) => Effect.Effect<void, ProjectFolderTransferError>;
  }
>()("t3/project/ProjectFolderTransfer") {}

const isTransferError = Schema.is(ProjectFolderTransferError);
const decodeSyncState = Schema.decodeUnknownSync(ProjectFolderSyncState);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const home = yield* HostProcess.HomeDirectory;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const locks = yield* KeyedLock.make<string>();
  const sessions = new Map<string, Transfer>();
  const watchers = new Map<
    string,
    { identity: string; token: string; revision: number; watcher: NodeFS.FSWatcher }
  >();
  const hashCaches = new Map<string, Map<string, { signature: string; hash: string }>>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of watchers.values()) entry.watcher.close();
      watchers.clear();
    }),
  );
  const closeWatcher = (root: string) => {
    watchers.get(root)?.watcher.close();
    watchers.delete(root);
  };
  const watchRevision = (root: string, identity: string) => {
    let current = watchers.get(root);
    if (current?.identity !== identity) {
      closeWatcher(root);
      const watcher = NodeFS.watch(root, { recursive: true }, () => {
        const entry = watchers.get(root);
        if (entry) entry.revision++;
      });
      current = { identity, token: NodeCrypto.randomUUID(), revision: 0, watcher };
      watchers.set(root, current);
      watcher.on("error", () => closeWatcher(root));
      watcher.unref();
    }
    return `${current.token}:${current.revision}`;
  };

  const io = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        isTransferError(cause) ? cause : new ProjectFolderTransferError({ reason: "io", cause }),
    });
  const fail = (reason: ProjectFolderTransferError["reason"]): never => {
    throw new ProjectFolderTransferError({ reason });
  };
  const inside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const validate = (entries: ReadonlyArray<ProjectFolderEntry>) => {
    const seen = new Map<string, ProjectFolderEntry>();
    for (const entry of entries) {
      // Use portable names, including when the sender and recipient use different operating systems.
      if (
        entry.path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              /[\\:\x00-\x1f<>"|?*]|[. ]$/.test(part) ||
              /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
          )
      )
        fail("invalid_path");
      if (seen.has(entry.path.toLowerCase())) fail("invalid_path");
      seen.set(entry.path.toLowerCase(), entry);
      if (entry.kind === "symlink") {
        const target = entry.linkTarget;
        if (
          !target ||
          target.includes("\\") ||
          target.includes(":") ||
          target.includes("\0") ||
          path.isAbsolute(target) ||
          !inside("/root", path.resolve("/root", path.dirname(entry.path), target))
        )
          fail("unsupported_entry");
      }
    }
    for (const entry of entries) {
      for (
        let parent = entry.path.split("/").slice(0, -1).join("/") || ".";
        parent !== ".";
        parent = parent.split("/").slice(0, -1).join("/") || "."
      ) {
        if (seen.get(parent.toLowerCase())?.kind !== "directory") fail("invalid_path");
      }
    }
  };
  const remove = async (id: string, transfer: Transfer) => {
    if (transfer.kind === "import")
      await NodeFSP.rm(transfer.root, { recursive: true, force: true });
    sessions.delete(id);
  };
  const prune = async () => {
    for (const [id, transfer] of sessions) {
      if (clock.currentTimeMillisUnsafe() - transfer.touchedAt > 30 * 60_000)
        await remove(id, transfer);
    }
    if (sessions.size >= 8) fail("invalid_session");
  };
  yield* Effect.addFinalizer(() =>
    io(async () => {
      await Promise.all([...sessions].map(([id, transfer]) => remove(id, transfer)));
    }).pipe(Effect.orDie),
  );

  const session = (id: string, kind: Transfer["kind"]) => {
    const transfer = sessions.get(id);
    if (
      !transfer ||
      transfer.kind !== kind ||
      clock.currentTimeMillisUnsafe() - transfer.touchedAt > 30 * 60_000
    )
      return fail("invalid_session");
    transfer.touchedAt = clock.currentTimeMillisUnsafe();
    return transfer;
  };

  const scan = async (root: string) => {
    root = await NodeFSP.realpath(root);
    const entries: ProjectFolderEntry[] = [];
    const modified = new Map<string, number>();
    const statsByPath = new Map<string, NodeFS.Stats>();
    const cached = hashCaches.get(root) ?? new Map<string, { signature: string; hash: string }>();
    hashCaches.delete(root);
    hashCaches.set(root, cached);
    if (hashCaches.size > 8) hashCaches.delete(hashCaches.keys().next().value!);
    const seenFiles = new Set<string>();
    const walk = async (directory: string) => {
      for (const name of await NodeFSP.readdir(path.join(root, directory))) {
        const relative = directory ? `${directory}/${name}` : name;
        const absolute = path.join(root, relative);
        const stat = await NodeFSP.lstat(absolute);
        const kind = stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : stat.isSymbolicLink()
              ? "symlink"
              : fail("unsupported_entry");
        let hash: string | undefined;
        const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (kind === "file") seenFiles.add(relative);
        if (kind === "file" && cached.get(relative)?.signature === signature) {
          hash = cached.get(relative)!.hash;
        } else if (kind === "file") {
          const digest = NodeCrypto.createHash("sha256");
          const handle = await NodeFSP.open(
            absolute,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
          );
          try {
            for await (const chunk of handle.createReadStream({ autoClose: false }))
              digest.update(chunk);
          } finally {
            await handle.close();
          }
          const after = await NodeFSP.lstat(absolute);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("source_changed");
          hash = digest.digest("hex");
          if (cached.size < 50_000 || cached.has(relative))
            cached.set(relative, { signature, hash });
        }
        const linkTarget = kind === "symlink" ? await NodeFSP.readlink(absolute) : undefined;
        if (kind === "symlink" && !inside(root, await NodeFSP.realpath(absolute)))
          fail("unsupported_entry");
        entries.push({
          path: relative,
          kind,
          byteLength: kind === "file" ? stat.size : 0,
          mode: stat.mode & 0o777,
          ...(hash === undefined ? {} : { hash }),
          ...(linkTarget === undefined ? {} : { linkTarget }),
        });
        modified.set(relative, stat.mtimeMs);
        statsByPath.set(relative, stat);
        if (kind === "directory") await walk(relative);
      }
    };
    await walk("");
    for (const key of cached.keys()) if (!seenFiles.has(key)) cached.delete(key);
    validate(entries);
    return { entries, modified, statsByPath };
  };
  const same = (
    left: ReadonlyArray<ProjectFolderEntry>,
    right: ReadonlyArray<ProjectFolderEntry>,
  ) =>
    JSON.stringify([...left].toSorted((a, b) => a.path.localeCompare(b.path))) ===
    JSON.stringify([...right].toSorted((a, b) => a.path.localeCompare(b.path)));
  const fileBytesUnchanged = (
    entry: ProjectFolderEntry,
    previous: ProjectFolderEntry | undefined,
  ) =>
    entry.kind === "file" &&
    !!entry.hash &&
    previous?.kind === "file" &&
    entry.hash === previous.hash;

  const applyIncrementalSync = async (
    transfer: Transfer,
    current: Awaited<ReturnType<typeof scan>>,
  ) => {
    const destination = await NodeFSP.realpath(transfer.destination!);
    const previous = new Map(transfer.previousEntries!.map((entry) => [entry.path, entry]));
    const signature = (stat: NodeFS.Stats) =>
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const assertUnchanged = async (entry: ProjectFolderEntry) => {
      const stat = await NodeFSP.lstat(path.join(destination, entry.path)).catch(() =>
        fail("source_changed"),
      );
      const expected = current.statsByPath.get(entry.path)!;
      // Our own child updates change directory timestamps; identity still has to match.
      if (
        entry.kind === "directory"
          ? !stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino
          : signature(stat) !== signature(expected)
      )
        fail("source_changed");
    };
    const parentInside = async (relative: string) => {
      if (
        !inside(destination, await NodeFSP.realpath(path.dirname(path.join(destination, relative))))
      )
        fail("source_changed");
    };
    // Replacing individual files keeps open working directories and unrelated file handles valid.
    // An interruption can leave a subset applied. The unchanged baseline lets the next sync resume.
    for (const entry of transfer.previousEntries!.toSorted(
      (a, b) => b.path.length - a.path.length,
    )) {
      const next = transfer.entriesByPath.get(entry.path);
      if (next?.kind === entry.kind) continue;
      await parentInside(entry.path);
      await assertUnchanged(entry);
      const absolute = path.join(destination, entry.path);
      if (entry.kind === "directory") await NodeFSP.rmdir(absolute);
      else await NodeFSP.unlink(absolute);
    }
    for (const entry of transfer.entries
      .filter((entry) => entry.kind === "directory")
      .toSorted((a, b) => a.path.length - b.path.length)) {
      if (previous.get(entry.path)?.kind === "directory") continue;
      await parentInside(entry.path);
      await NodeFSP.mkdir(path.join(destination, entry.path), { mode: 0o700 });
    }
    for (const entry of transfer.entries.filter((entry) => entry.kind !== "directory")) {
      const before = previous.get(entry.path);
      if (fileBytesUnchanged(entry, before)) {
        if (entry.mode !== before!.mode) {
          await parentInside(entry.path);
          await assertUnchanged(before!);
          await NodeFSP.chmod(path.join(destination, entry.path), entry.mode & 0o777);
        }
        continue;
      }
      if (
        entry.kind === "symlink" &&
        before?.kind === "symlink" &&
        entry.linkTarget === before.linkTarget
      )
        continue;
      await parentInside(entry.path);
      const absolute = path.join(destination, entry.path);
      const staged = path.join(transfer.root, entry.path);
      if (before?.kind === entry.kind) {
        await assertUnchanged(before);
        await NodeFSP.rename(staged, absolute);
      } else if (entry.kind === "file") {
        // Hard-linking a private staged file exclusively creates a new path without overwriting a concurrent edit.
        await NodeFSP.link(staged, absolute);
      } else await NodeFSP.symlink(entry.linkTarget!, absolute);
    }
    for (const entry of transfer.entries
      .filter((entry) => entry.kind === "directory")
      .toSorted((a, b) => b.path.length - a.path.length)) {
      const before = previous.get(entry.path);
      if (before?.kind === "directory" && before.mode === entry.mode) continue;
      await parentInside(entry.path);
      if (before?.kind === "directory") await assertUnchanged(before);
      await NodeFSP.chmod(path.join(destination, entry.path), entry.mode & 0o777);
    }
  };
  const syncPath = async (cwd: string) => {
    const root = await NodeFSP.realpath(expandHomePath(cwd, home));
    return path.join(
      config.stateDir,
      "folder-sync",
      `${NodeCrypto.createHash("sha256").update(root).digest("hex")}.json`,
    );
  };
  const status: ProjectFolderTransfer["Service"]["status"] = Effect.fn(
    "ProjectFolderTransfer.status",
  )(function* ({ cwd }) {
    return yield* io(async () => {
      const absolute = path.resolve(expandHomePath(cwd, home));
      const stat = await NodeFSP.stat(absolute).catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
      if (stat === null) return { cwd: absolute, exists: false, revision: "missing", sync: null };
      if (!stat.isDirectory()) fail("invalid_path");
      const root = await NodeFSP.realpath(absolute);
      const file = await syncPath(root);
      const contents = await NodeFSP.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
      const sync = contents === null ? null : decodeSyncState(JSON.parse(contents));
      if (!sync?.automatic) closeWatcher(root);
      const revision = sync?.automatic
        ? watchRevision(root, `${stat.dev}:${stat.ino}`)
        : "inactive";
      return {
        cwd: root,
        exists: true,
        revision,
        sync:
          sync === null
            ? null
            : {
                peerEnvironmentId: sync.peerEnvironmentId,
                peerPath: sync.peerPath,
                ...(sync.automatic === undefined ? {} : { automatic: sync.automatic }),
                ...(sync.coordinatorEnvironmentId === undefined
                  ? {}
                  : { coordinatorEnvironmentId: sync.coordinatorEnvironmentId }),
              },
      };
    });
  });
  const getSync: ProjectFolderTransfer["Service"]["getSync"] = Effect.fn(
    "ProjectFolderTransfer.getSync",
  )(function* ({ cwd }) {
    yield* knownWorkspaces
      .assertContains(cwd)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectFolderTransferError({ reason: "invalid_path", cause }),
        ),
      );
    return yield* io(async () => {
      const file = await syncPath(cwd);
      const contents = await NodeFSP.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
      return contents === null ? null : decodeSyncState(JSON.parse(contents));
    });
  });
  const setSync: ProjectFolderTransfer["Service"]["setSync"] = Effect.fn(
    "ProjectFolderTransfer.setSync",
  )(function* ({ cwd, state }) {
    yield* knownWorkspaces
      .assertContains(cwd)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectFolderTransferError({ reason: "invalid_path", cause }),
        ),
      );
    return yield* io(async () => {
      const file = await syncPath(cwd);
      if (state === null) {
        closeWatcher(await NodeFSP.realpath(expandHomePath(cwd, home)));
        await NodeFSP.rm(file, { force: true });
        return;
      }
      validate(state.baseline);
      await NodeFSP.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${NodeCrypto.randomUUID()}`;
      try {
        await NodeFSP.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await NodeFSP.rename(temporary, file);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    });
  });

  const exportFolder: ProjectFolderTransfer["Service"]["exportFolder"] = Effect.fn(
    "ProjectFolderTransfer.exportFolder",
  )(function* ({ cwd }) {
    yield* knownWorkspaces
      .assertContains(cwd)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectFolderTransferError({ reason: "invalid_path", cause }),
        ),
      );
    return yield* io(async () => {
      await prune();
      const root = await NodeFSP.realpath(expandHomePath(cwd, home));
      const { entries, modified } = await scan(root);
      const transferId = NodeCrypto.randomUUID();
      sessions.set(transferId, {
        kind: "export",
        root,
        destination: null,
        entries,
        entriesByPath: new Map(entries.map((entry) => [entry.path, entry])),
        offsets: new Map(),
        pendingOffsets: new Map(),
        modified,
        touchedAt: clock.currentTimeMillisUnsafe(),
      });
      return { transferId, entries };
    });
  });

  const importFolder: ProjectFolderTransfer["Service"]["importFolder"] = Effect.fn(
    "ProjectFolderTransfer.importFolder",
  )(function* (input) {
    if (input.previousEntries !== undefined)
      yield* knownWorkspaces
        .assertContains(input.destinationPath)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectFolderTransferError({ reason: "invalid_path", cause }),
          ),
        );
    return yield* io(async () => {
      await prune();
      if (input.incremental && input.previousEntries === undefined) fail("invalid_path");
      validate(input.entries);
      const destination = path.resolve(expandHomePath(input.destinationPath, home));
      if (input.previousEntries === undefined) {
        if (
          await NodeFSP.lstat(destination).then(
            () => true,
            (error: NodeJS.ErrnoException) =>
              error.code === "ENOENT" ? false : Promise.reject(error),
          )
        )
          fail("destination_exists");
      } else {
        if (!same((await scan(destination)).entries, input.previousEntries)) fail("source_changed");
      }
      await NodeFSP.mkdir(path.dirname(destination), { recursive: true });
      const root = await NodeFSP.mkdtemp(path.join(path.dirname(destination), ".t3-folder-"));
      const transferId = NodeCrypto.randomUUID();
      sessions.set(transferId, {
        kind: "import",
        incremental: input.incremental === true,
        root,
        destination,
        entries: input.entries,
        entriesByPath: new Map(input.entries.map((entry) => [entry.path, entry])),
        ...(input.previousEntries === undefined ? {} : { previousEntries: input.previousEntries }),
        offsets: new Map(),
        pendingOffsets: new Map(),
        modified: new Map(),
        touchedAt: clock.currentTimeMillisUnsafe(),
      });
      const previousEntriesByPath = new Map(
        input.previousEntries?.map((entry) => [entry.path, entry]),
      );
      const hasLinks = input.entries.some((entry) => entry.kind === "symlink");
      try {
        for (const entry of input.entries
          .filter((entry) => entry.kind === "directory")
          .toSorted((a, b) => a.path.length - b.path.length))
          await NodeFSP.mkdir(path.join(root, entry.path), { recursive: true });
        for (const entry of input.entries.filter((entry) => entry.kind === "file")) {
          const previous = previousEntriesByPath.get(entry.path);
          if (entry.hash && previous?.kind === "file" && previous.hash === entry.hash) {
            if (!input.incremental)
              await NodeFSP.copyFile(
                path.join(destination, entry.path),
                path.join(root, entry.path),
                NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
              );
            else if (hasLinks)
              // Only link validation needs a placeholder; retained file bytes are never installed from staging.
              await NodeFSP.writeFile(path.join(root, entry.path), new Uint8Array(), {
                flag: "wx",
                mode: 0o600,
              });
            sessions.get(transferId)!.offsets.set(entry.path, entry.byteLength);
          } else
            await NodeFSP.writeFile(path.join(root, entry.path), new Uint8Array(), {
              flag: "wx",
              mode: 0o600,
            });
        }
      } catch (cause) {
        await remove(transferId, sessions.get(transferId)!);
        throw cause;
      }
      return { transferId, parallelChunks: true };
    });
  });

  const read: ProjectFolderTransfer["Service"]["read"] = Effect.fn("ProjectFolderTransfer.read")(
    (input) =>
      io(async () => {
        const transfer = session(input.transferId, "export");
        const entry = transfer.entriesByPath.get(input.relativePath);
        if (!entry || entry.kind !== "file" || input.offset > entry.byteLength)
          return fail("invalid_chunk");
        const absolute = path.join(transfer.root, input.relativePath);
        if (!inside(transfer.root, await NodeFSP.realpath(absolute))) fail("source_changed");
        const handle = await NodeFSP.open(
          absolute,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.size !== entry.byteLength ||
            stat.mtimeMs !== transfer.modified.get(entry.path)
          )
            fail("source_changed");
          const buffer = Buffer.alloc(
            Math.min(PROJECT_FOLDER_CHUNK_BYTES, entry.byteLength - input.offset),
          );
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
          if (bytesRead !== buffer.length) fail("source_changed");
          return { contents: buffer.toString("base64") };
        } finally {
          await handle.close();
        }
      }),
  );

  const write: ProjectFolderTransfer["Service"]["write"] = Effect.fn("ProjectFolderTransfer.write")(
    (input) =>
      locks.withLock(
        input.transferId,
        io(async () => {
          const transfer = session(input.transferId, "import");
          const entry = transfer.entriesByPath.get(input.relativePath);
          const buffer = Buffer.from(input.contents, "base64");
          const offset = transfer.offsets.get(input.relativePath) ?? 0;
          const pending = transfer.pendingOffsets.get(input.relativePath) ?? new Set<number>();
          if (
            !entry ||
            entry.kind !== "file" ||
            input.offset < offset ||
            input.offset % PROJECT_FOLDER_CHUNK_BYTES !== 0 ||
            pending.has(input.offset) ||
            buffer.length === 0 ||
            buffer.length !==
              Math.min(PROJECT_FOLDER_CHUNK_BYTES, entry.byteLength - input.offset) ||
            buffer.toString("base64") !== input.contents
          )
            return fail("invalid_chunk");
          const handle = await NodeFSP.open(
            path.join(transfer.root, entry.path),
            NodeFS.constants.O_WRONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
          );
          try {
            let written = 0;
            while (written < buffer.length) {
              const { bytesWritten } = await handle.write(
                buffer,
                written,
                buffer.length - written,
                input.offset + written,
              );
              if (bytesWritten === 0) fail("io");
              written += bytesWritten;
            }
          } finally {
            await handle.close();
          }
          pending.add(input.offset);
          let next = offset;
          while (pending.delete(next))
            next += Math.min(PROJECT_FOLDER_CHUNK_BYTES, entry.byteLength - next);
          transfer.offsets.set(entry.path, next);
          if (pending.size > 0) transfer.pendingOffsets.set(entry.path, pending);
          else transfer.pendingOffsets.delete(entry.path);
        }),
      ),
  );

  const finish: ProjectFolderTransfer["Service"]["finish"] = Effect.fn(
    "ProjectFolderTransfer.finish",
  )(({ transferId }) =>
    locks.withLock(
      transferId,
      Effect.gen(function* () {
        const transfer = yield* io(async () => session(transferId, "import"));
        return yield* locks.withLock(
          `destination:${transfer.destination}`,
          io(async () => {
            const previous = new Map(transfer.previousEntries?.map((entry) => [entry.path, entry]));
            const retained = (entry: ProjectFolderEntry) =>
              transfer.incremental && fileBytesUnchanged(entry, previous.get(entry.path));
            const hasLinks = transfer.entries.some((entry) => entry.kind === "symlink");
            for (const entry of transfer.entries) {
              if (
                entry.kind === "file" &&
                (transfer.offsets.get(entry.path) ?? 0) !== entry.byteLength
              )
                fail("incomplete");
            }
            for (const entry of transfer.entries) {
              const absolute = path.join(transfer.root, entry.path);
              if (entry.kind === "symlink") await NodeFSP.symlink(entry.linkTarget!, absolute);
              else if (entry.kind === "file" && (!retained(entry) || hasLinks))
                await NodeFSP.chmod(absolute, entry.mode & 0o777);
            }
            const staged = await scan(transfer.root);
            const stagedEntriesByPath = new Map(staged.entries.map((entry) => [entry.path, entry]));
            const expectedFiles = transfer.entries.filter(
              (entry) => entry.kind === "file" && !retained(entry),
            );
            for (const entry of expectedFiles) {
              if (entry.hash && stagedEntriesByPath.get(entry.path)?.hash !== entry.hash)
                fail("invalid_chunk");
            }
            for (const entry of transfer.entries
              .filter((entry) => entry.kind === "directory")
              .toSorted((a, b) => b.path.length - a.path.length))
              await NodeFSP.chmod(path.join(transfer.root, entry.path), entry.mode & 0o777);
            const destination = transfer.destination!;
            if (transfer.previousEntries !== undefined) {
              const current = await scan(destination);
              if (!same(current.entries, transfer.previousEntries)) fail("source_changed");
              if (transfer.incremental) {
                await applyIncrementalSync(transfer, current);
                await remove(transferId, transfer);
                return { cwd: destination };
              }
              const backup = `${transfer.root}-previous`;
              await NodeFSP.rename(destination, backup);
              try {
                await NodeFSP.rename(transfer.root, destination);
              } catch (cause) {
                await NodeFSP.rename(backup, destination);
                throw cause;
              }
              sessions.delete(transferId);
              await NodeFSP.rm(backup, { recursive: true, force: true });
              return { cwd: destination };
            }
            // Reserve the destination exclusively; rename must never replace somebody else's folder.
            await NodeFSP.mkdir(destination).catch((cause: NodeJS.ErrnoException) => {
              if (cause.code === "EEXIST") fail("destination_exists");
              throw cause;
            });
            try {
              await NodeFSP.rename(transfer.root, destination);
            } catch (cause) {
              await NodeFSP.rmdir(destination);
              throw cause;
            }
            sessions.delete(transferId);
            return { cwd: destination };
          }),
        );
      }),
    ),
  );

  const exportEnd: ProjectFolderTransfer["Service"]["exportEnd"] = Effect.fn(
    "ProjectFolderTransfer.exportEnd",
  )((input) =>
    locks.withLock(
      input.transferId,
      io(async () => {
        const transfer = sessions.get(input.transferId);
        if (!transfer) return;
        if (transfer.kind !== "export") fail("invalid_session");
        try {
          if (input.validate && !same((await scan(transfer.root)).entries, transfer.entries))
            fail("source_changed");
        } finally {
          sessions.delete(input.transferId);
        }
      }),
    ),
  );

  const cancel: ProjectFolderTransfer["Service"]["cancel"] = Effect.fn(
    "ProjectFolderTransfer.cancel",
  )(({ transferId }) =>
    locks.withLock(
      transferId,
      io(async () => {
        const transfer = sessions.get(transferId);
        if (transfer) await remove(transferId, transfer);
      }),
    ),
  );

  return ProjectFolderTransfer.of({
    exportEnd,
    status,
    getSync,
    setSync,
    exportFolder,
    importFolder,
    read,
    write,
    finish,
    cancel,
  });
});

export const layer = Layer.effect(ProjectFolderTransfer, make);
