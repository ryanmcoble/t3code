import { SetupProfileError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SetupPackages from "./SetupPackages.ts";
import * as SetupProfileStore from "./SetupProfileStore.ts";

export interface SetupFile {
  readonly path: string;
  readonly root: string;
  readonly digest: string;
  readonly executable: boolean;
}

export class SetupFiles extends Context.Service<
  SetupFiles,
  {
    readonly apply: (
      profileId: string,
      files: ReadonlyArray<SetupFile>,
    ) => Effect.Effect<ReadonlyArray<string>, SetupProfileError>;
    readonly inspect: (
      profileId: string,
    ) => Effect.Effect<ReadonlyArray<string>, SetupProfileError>;
    readonly detach: (
      profileId: string,
      remove: boolean,
    ) => Effect.Effect<ReadonlyArray<string>, SetupProfileError>;
    readonly resolve: (
      path: string,
      resolution: "keep-local" | "use-profile",
    ) => Effect.Effect<void, SetupProfileError>;
  }
>()("t3/setupProfiles/SetupFiles") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const store = yield* SetupProfileStore.SetupProfileStore;
  const packages = yield* SetupPackages.SetupPackages;
  const storageError = (cause: unknown) => new SetupProfileError({ reason: "storage", cause });
  const currentDigest = Effect.fn("SetupFiles.currentDigest")(function* (target: string) {
    const exists = yield* fs.exists(target).pipe(Effect.mapError(storageError));
    if (!exists) return null;
    if (
      yield* fs.readLink(target).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      )
    ) {
      return "symlink";
    }
    const stat = yield* fs.stat(target).pipe(Effect.mapError(storageError));
    if (stat.type !== "File") return "directory";
    if (Number(stat.size) > 64 * 1024 * 1024) return "too-large";
    const bytes = yield* fs.readFile(target).pipe(Effect.mapError(storageError));
    return `${yield* packages.digest(bytes)}:${stat.mode & 0o111 ? "x" : "r"}`;
  });
  const contained = Effect.fn("SetupFiles.contained")(function* (target: string, root: string) {
    let ancestor = path.dirname(target);
    while (!(yield* fs.exists(ancestor))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
    const real = yield* fs.realPath(ancestor);
    const relative = path.relative(root, real);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }, Effect.mapError(storageError));
  const atomicWrite = Effect.fn("SetupFiles.atomicWrite")(function* (file: SetupFile) {
    const parent = path.dirname(file.path);
    yield* fs
      .makeDirectory(parent, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(storageError));
    const root = yield* fs.realPath(file.root).pipe(Effect.mapError(storageError));
    const realParent = yield* fs.realPath(parent).pipe(Effect.mapError(storageError));
    const relative = path.relative(root, realParent);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* new SetupProfileError({ reason: "invalid" });
    }
    const temp = path.join(parent, `.t3-setup-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`);
    const bytes = yield* packages.read(file.digest);
    yield* fs
      .writeFile(temp, bytes, { mode: file.executable ? 0o700 : 0o600 })
      .pipe(Effect.mapError(storageError));
    yield* fs.rename(temp, file.path).pipe(Effect.mapError(storageError));
  });
  const remove = Effect.fn("SetupFiles.remove")(function* (p: SetupProfileStore.ManagedSetupPath) {
    if (p.overridden) {
      yield* store.removePath(p.path);
      return true;
    }
    if (!(yield* contained(p.path, p.root))) return false;
    const current = yield* currentDigest(p.path);
    if (current === null) {
      yield* store.removePath(p.path);
      return true;
    }
    if (current !== p.digest && current !== p.pending_digest) return false;
    yield* store.savePath({ ...p, pending_digest: "remove" });
    yield* fs.remove(p.path).pipe(Effect.mapError(storageError));
    yield* store.removePath(p.path);
    return true;
  });
  const inspect = Effect.fn("SetupFiles.inspect")(function* (profileId: string) {
    const conflicts: string[] = [];
    for (const entry of yield* store.paths) {
      if (entry.profile_id !== profileId || entry.overridden) continue;
      if (
        !(yield* contained(entry.path, entry.root)) ||
        (yield* currentDigest(entry.path)) !== entry.digest
      )
        conflicts.push(entry.path);
    }
    return conflicts;
  });
  const apply = Effect.fn("SetupFiles.apply")(function* (
    profileId: string,
    files: ReadonlyArray<SetupFile>,
  ) {
    const managed = new Map((yield* store.paths).map((p) => [p.path, p]));
    const conflicts: string[] = [];
    const wanted = new Set(files.map((f) => f.path));
    for (const file of files) {
      const previous = managed.get(file.path);
      if (previous?.overridden) continue;
      yield* fs
        .makeDirectory(file.root, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(storageError));
      const root =
        previous?.root ?? (yield* fs.realPath(file.root).pipe(Effect.mapError(storageError)));
      if (!(yield* contained(file.path, root))) {
        conflicts.push(file.path);
        continue;
      }
      const actual = yield* currentDigest(file.path);
      const desired = `${file.digest}:${file.executable ? "x" : "r"}`;
      const recovered = previous?.pending_digest === actual && actual !== null;
      if (
        actual !== null &&
        (!previous ||
          previous.profile_id !== profileId ||
          (!recovered && actual !== previous.digest))
      ) {
        if (!previous)
          yield* store.savePath({
            path: file.path,
            root,
            profile_id: profileId,
            digest: null,
            pending_digest: null,
            overridden: 0,
          });
        conflicts.push(file.path);
        continue;
      }
      const entry = {
        path: file.path,
        root,
        profile_id: profileId,
        digest: actual,
        pending_digest: desired,
        overridden: 0,
      };
      yield* store.savePath(entry);
      if (actual !== desired) yield* atomicWrite(file);
      const settled = { ...entry, digest: desired, pending_digest: null };
      yield* store.savePath(settled);
      managed.set(file.path, settled);
    }
    for (const p of managed.values()) {
      if (p.profile_id === profileId && !wanted.has(p.path) && !(yield* remove(p)))
        conflicts.push(p.path);
    }
    return conflicts;
  });
  const detach = Effect.fn("SetupFiles.detach")(function* (
    profileId: string,
    removeManaged: boolean,
  ) {
    const conflicts: string[] = [];
    for (const entry of yield* store.paths) {
      if (entry.profile_id !== profileId) continue;
      if (removeManaged && !(yield* remove(entry))) conflicts.push(entry.path);
      else yield* store.removePath(entry.path);
    }
    return conflicts;
  });
  const resolve = Effect.fn("SetupFiles.resolve")(function* (
    target: string,
    resolution: "keep-local" | "use-profile",
  ) {
    const entry = (yield* store.paths).find((p) => p.path === target);
    if (!entry) return yield* new SetupProfileError({ reason: "not-found" });
    if (resolution === "keep-local") {
      yield* store.savePath({ ...entry, overridden: 1 });
      return;
    }
    if (!(yield* contained(target, entry.root)))
      return yield* new SetupProfileError({ reason: "invalid" });
    const digest = yield* currentDigest(target);
    if (
      ["symlink", "directory", "too-large"].includes(digest ?? "") &&
      resolution === "use-profile"
    )
      return yield* new SetupProfileError({ reason: "invalid" });
    yield* store.savePath({ ...entry, digest, pending_digest: null, overridden: 0 });
  });
  return SetupFiles.of({ apply, inspect, detach, resolve });
});

export const layer = Layer.effect(SetupFiles, make);
