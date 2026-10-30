// @effect-diagnostics nodeBuiltinImport:off -- Chunked binary I/O needs no-follow opens and exclusive destination creation.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";

import {
  PROJECT_FOLDER_CHUNK_BYTES,
  PROJECT_FOLDER_MAX_BYTES,
  PROJECT_FOLDER_MAX_ENTRIES,
  ProjectFolderTransferError,
  ProjectFolderSyncState,
  type ProjectFolderEntry,
  type ProjectFolderExportInput,
  type ProjectFolderExportResult,
  type ProjectFolderImportInput,
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
  readonly offsets: Map<string, number>;
  readonly modified: Map<string, number>;
  readonly previousEntries?: ReadonlyArray<ProjectFolderEntry>;
  touchedAt: number;
}

export class ProjectFolderTransfer extends Context.Service<
  ProjectFolderTransfer,
  {
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
    ) => Effect.Effect<{ transferId: string }, ProjectFolderTransferError>;
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
    let bytes = 0;
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
      bytes += entry.byteLength;
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
    if (entries.length > PROJECT_FOLDER_MAX_ENTRIES || bytes > PROJECT_FOLDER_MAX_BYTES)
      fail("too_large");
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
    let bytes = 0;
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
        if (kind === "file") {
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
        }
        const linkTarget = kind === "symlink" ? await NodeFSP.readlink(absolute) : undefined;
        if (kind === "symlink" && !inside(root, await NodeFSP.realpath(absolute)))
          fail("unsupported_entry");
        bytes += kind === "file" ? stat.size : 0;
        entries.push({
          path: relative,
          kind,
          byteLength: kind === "file" ? stat.size : 0,
          mode: stat.mode & 0o777,
          ...(hash === undefined ? {} : { hash }),
          ...(linkTarget === undefined ? {} : { linkTarget }),
        });
        if (entries.length > PROJECT_FOLDER_MAX_ENTRIES || bytes > PROJECT_FOLDER_MAX_BYTES)
          fail("too_large");
        modified.set(relative, stat.mtimeMs);
        if (kind === "directory") await walk(relative);
      }
    };
    await walk("");
    validate(entries);
    return { entries, modified };
  };
  const same = (
    left: ReadonlyArray<ProjectFolderEntry>,
    right: ReadonlyArray<ProjectFolderEntry>,
  ) =>
    JSON.stringify([...left].toSorted((a, b) => a.path.localeCompare(b.path))) ===
    JSON.stringify([...right].toSorted((a, b) => a.path.localeCompare(b.path)));
  const syncPath = async (cwd: string) => {
    const root = await NodeFSP.realpath(expandHomePath(cwd, home));
    return path.join(
      config.stateDir,
      "folder-sync",
      `${NodeCrypto.createHash("sha256").update(root).digest("hex")}.json`,
    );
  };
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
        offsets: new Map(),
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
        root,
        destination,
        entries: input.entries,
        ...(input.previousEntries === undefined ? {} : { previousEntries: input.previousEntries }),
        offsets: new Map(),
        modified: new Map(),
        touchedAt: clock.currentTimeMillisUnsafe(),
      });
      try {
        for (const entry of input.entries
          .filter((entry) => entry.kind === "directory")
          .toSorted((a, b) => a.path.length - b.path.length))
          await NodeFSP.mkdir(path.join(root, entry.path), { recursive: true });
        for (const entry of input.entries.filter((entry) => entry.kind === "file")) {
          const previous = input.previousEntries?.find(
            (candidate) => candidate.path === entry.path,
          );
          if (entry.hash && previous?.kind === "file" && previous.hash === entry.hash) {
            await NodeFSP.copyFile(
              path.join(destination, entry.path),
              path.join(root, entry.path),
              NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
            );
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
      return { transferId };
    });
  });

  const read: ProjectFolderTransfer["Service"]["read"] = Effect.fn("ProjectFolderTransfer.read")(
    (input) =>
      io(async () => {
        const transfer = session(input.transferId, "export");
        const entry = transfer.entries.find(
          (entry) => entry.path === input.relativePath && entry.kind === "file",
        );
        if (!entry || input.offset > entry.byteLength) return fail("invalid_chunk");
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
          const entry = transfer.entries.find(
            (entry) => entry.path === input.relativePath && entry.kind === "file",
          );
          const buffer = Buffer.from(input.contents, "base64");
          const offset = transfer.offsets.get(input.relativePath) ?? 0;
          if (
            !entry ||
            input.offset !== offset ||
            buffer.length === 0 ||
            buffer.length > PROJECT_FOLDER_CHUNK_BYTES ||
            offset + buffer.length > entry.byteLength ||
            buffer.toString("base64") !== input.contents
          )
            return fail("invalid_chunk");
          await NodeFSP.appendFile(path.join(transfer.root, entry.path), buffer);
          transfer.offsets.set(entry.path, offset + buffer.length);
        }),
      ),
  );

  const finish: ProjectFolderTransfer["Service"]["finish"] = Effect.fn(
    "ProjectFolderTransfer.finish",
  )(({ transferId }) =>
    locks.withLock(
      transferId,
      io(async () => {
        const transfer = session(transferId, "import");
        for (const entry of transfer.entries) {
          if (entry.kind === "file" && (transfer.offsets.get(entry.path) ?? 0) !== entry.byteLength)
            fail("incomplete");
        }
        for (const entry of transfer.entries) {
          const absolute = path.join(transfer.root, entry.path);
          if (entry.kind === "symlink") await NodeFSP.symlink(entry.linkTarget!, absolute);
          else if (entry.kind === "file") await NodeFSP.chmod(absolute, entry.mode & 0o777);
        }
        const staged = await scan(transfer.root);
        const expectedFiles = transfer.entries.filter((entry) => entry.kind === "file");
        for (const entry of expectedFiles) {
          if (
            entry.hash &&
            staged.entries.find((candidate) => candidate.path === entry.path)?.hash !== entry.hash
          )
            fail("invalid_chunk");
        }
        for (const entry of transfer.entries
          .filter((entry) => entry.kind === "directory")
          .toSorted((a, b) => b.path.length - a.path.length))
          await NodeFSP.chmod(path.join(transfer.root, entry.path), entry.mode & 0o777);
        const destination = transfer.destination!;
        if (transfer.previousEntries !== undefined) {
          if (!same((await scan(destination)).entries, transfer.previousEntries))
            fail("source_changed");
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
