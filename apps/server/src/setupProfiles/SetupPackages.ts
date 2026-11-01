import { SetupProfileError, type SetupSkill } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  MAX_SETUP_FILES,
  MAX_SETUP_PACKAGE_BYTES,
  MAX_SETUP_PROFILE_BYTES,
  validSetupName,
  validSetupPath,
} from "./validation.ts";

export class SetupPackages extends Context.Service<
  SetupPackages,
  {
    readonly digest: (bytes: Uint8Array) => Effect.Effect<string>;
    readonly read: (digest: string) => Effect.Effect<Uint8Array, SetupProfileError>;
    readonly put: (
      bytes: Uint8Array,
      expectedDigest?: string,
    ) => Effect.Effect<string, SetupProfileError>;
    readonly importSkill: (directory: string) => Effect.Effect<SetupSkill, SetupProfileError>;
  }
>()("t3/setupProfiles/SetupPackages") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const root = path.join(config.stateDir, "setup-profiles", "blobs");
  const storageError = (cause: unknown) => new SetupProfileError({ reason: "storage", cause });
  const digest = Effect.fn("SetupPackages.digest")((bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(
      Effect.map((bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")),
      Effect.orDie,
    ),
  );
  const read = Effect.fn("SetupPackages.read")(function* (hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return yield* new SetupProfileError({ reason: "invalid" });
    const file = path.join(root, hash);
    const stat = yield* fs.stat(file).pipe(Effect.mapError(storageError));
    if (Number(stat.size) > MAX_SETUP_PACKAGE_BYTES)
      return yield* new SetupProfileError({ reason: "invalid" });
    const bytes = yield* fs.readFile(file).pipe(Effect.mapError(storageError));
    if ((yield* digest(bytes)) !== hash) return yield* new SetupProfileError({ reason: "invalid" });
    return bytes;
  });
  const put = Effect.fn("SetupPackages.put")(function* (bytes: Uint8Array, expected?: string) {
    if (bytes.byteLength > MAX_SETUP_PACKAGE_BYTES)
      return yield* new SetupProfileError({ reason: "invalid" });
    const hash = yield* digest(bytes);
    if (expected !== undefined && hash !== expected)
      return yield* new SetupProfileError({ reason: "invalid" });
    yield* fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(storageError));
    const target = path.join(root, hash);
    if (!(yield* fs.exists(target).pipe(Effect.mapError(storageError)))) {
      const temp = path.join(
        root,
        `${hash}.${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.tmp`,
      );
      yield* fs.writeFile(temp, bytes, { mode: 0o600 }).pipe(Effect.mapError(storageError));
      yield* fs.rename(temp, target).pipe(Effect.mapError(storageError));
    }
    return hash;
  });
  const importSkill = Effect.fn("SetupPackages.importSkill")(function* (directory: string) {
    const root = yield* fs.realPath(directory).pipe(Effect.mapError(storageError));
    const name = path.basename(directory);
    if (!validSetupName(name)) return yield* new SetupProfileError({ reason: "invalid" });
    const files: Array<SetupSkill["files"][number]> = [];
    const visited = new Set<string>();
    let size = 0;
    const walk = Effect.fn("SetupPackages.walk")(function* (
      relative: string,
    ): Effect.fn.Return<void, SetupProfileError> {
      const location = path.join(root, relative);
      const real = yield* fs.realPath(location).pipe(Effect.mapError(storageError));
      const inside = path.relative(root, real);
      if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
        return yield* new SetupProfileError({ reason: "invalid" });
      const stat = yield* fs.stat(real).pipe(Effect.mapError(storageError));
      if (stat.type === "Directory") {
        if (visited.has(real)) return yield* new SetupProfileError({ reason: "invalid" });
        visited.add(real);
        const entries = yield* fs.readDirectory(real).pipe(Effect.mapError(storageError));
        for (const entry of entries.sort()) {
          if ([".git", "node_modules", ".DS_Store", "__pycache__"].includes(entry)) continue;
          if (
            /^(?:\.env(?:\..*)?|auth\.json|credentials\.json)$/.test(entry) &&
            entry !== ".env.example"
          )
            continue;
          yield* walk(relative ? `${relative}/${entry}` : entry);
        }
        visited.delete(real);
      } else if (stat.type === "File") {
        size += Number(stat.size);
        if (
          !validSetupPath(relative) ||
          size > MAX_SETUP_PROFILE_BYTES ||
          files.length >= MAX_SETUP_FILES
        )
          return yield* new SetupProfileError({ reason: "invalid" });
        const bytes = yield* fs.readFile(real).pipe(Effect.mapError(storageError));
        files.push({
          path: relative,
          digest: yield* put(bytes),
          size: bytes.length,
          executable: (stat.mode & 0o111) !== 0,
        });
      } else return yield* new SetupProfileError({ reason: "invalid" });
    });
    yield* walk("");
    if (!files.some((f) => f.path === "SKILL.md"))
      return yield* new SetupProfileError({ reason: "invalid" });
    return { name, files, drivers: [] };
  });
  return SetupPackages.of({ digest, read, put, importSkill });
});

export const layer = Layer.effect(SetupPackages, make);
