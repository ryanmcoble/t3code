import { SetupProfile, SetupProfileError, setupProfileReadiness } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, GlobalFlag } from "effect/cli";

import { acquireServerOwnership } from "../serverOwnership.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SetupProfileStore from "../setupProfiles/SetupProfileStore.ts";
import * as SetupPackages from "../setupProfiles/SetupPackages.ts";
import { validateSetupProfile } from "../setupProfiles/validation.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(SetupProfile));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(SetupProfile));

const withStore = Effect.fn("setup.withStore")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<A, E, R>,
  requiresStopped = false,
) {
  const level = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, level);
  const provided = run.pipe(
    Effect.provide(
      Layer.mergeAll(SetupProfileStore.layer, SetupPackages.layer, ServerEnvironment.layer).pipe(
        Layer.provide(ProcessRunner.layer),
        Layer.provideMerge(Sqlite.layerConfig),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layer(config)),
      ),
    ),
  );
  return yield* requiresStopped
    ? Effect.scoped(
        acquireServerOwnership(config.serverRuntimeStatePath).pipe(
          Effect.provide(ProcessRunner.layer),
          Effect.andThen(provided),
        ),
      )
    : provided;
});

const status = Command.make("status", authLocationFlags).pipe(
  Command.withDescription("Read this environment's setup profile readiness as JSON."),
  Command.withHandler((flags) =>
    withStore(
      flags,
      Effect.gen(function* () {
        const store = yield* SetupProfileStore.SetupProfileStore;
        const binding = yield* store.binding;
        yield* Console.log(yield* encodeJson(setupProfileReadiness(binding)));
      }),
    ),
  ),
);
const exportProfile = Command.make("export", {
  ...authLocationFlags,
  profile: Argument.String("profile"),
  directory: Argument.String("directory"),
}).pipe(
  Command.withDescription(
    "Export a profile and complete skill blobs into a new directory. Credentials are excluded.",
  ),
  Command.withHandler((flags) =>
    withStore(
      flags,
      Effect.gen(function* () {
        const store = yield* SetupProfileStore.SetupProfileStore;
        const packages = yield* SetupPackages.SetupPackages;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* store.get(flags.profile);
        const root = path.resolve(flags.directory);
        yield* fs.makeDirectory(root, { mode: 0o700 });
        yield* fs.makeDirectory(path.join(root, "blobs"), { mode: 0o700 });
        const digests = new Set(profile.skills.flatMap((s) => s.files.map((f) => f.digest)));
        for (const digest of digests)
          yield* fs.writeFile(path.join(root, "blobs", digest), yield* packages.read(digest), {
            mode: 0o600,
          });
        yield* fs.writeFileString(path.join(root, "profile.json"), yield* encodeProfile(profile), {
          mode: 0o600,
        });
        yield* Console.log(root);
      }),
    ),
  ),
);
const restore = Command.make("restore", {
  ...authLocationFlags,
  directory: Argument.String("directory"),
}).pipe(
  Command.withDescription(
    "Restore a backup as a new owned profile. Environments must explicitly enroll again.",
  ),
  Command.withHandler((flags) =>
    withStore(
      flags,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const packages = yield* SetupPackages.SetupPackages;
        const store = yield* SetupProfileStore.SetupProfileStore;
        const environment = yield* ServerEnvironment.ServerEnvironment;
        const crypto = yield* Crypto.Crypto;
        const root = path.resolve(flags.directory);
        const original = yield* fs
          .readFileString(path.join(root, "profile.json"))
          .pipe(Effect.flatMap(decodeProfile));
        yield* Effect.try({
          try: () => validateSetupProfile(original),
          catch: () => new SetupProfileError({ reason: "invalid" }),
        });
        for (const skill of original.skills)
          for (const file of skill.files) {
            const bytes = yield* fs.readFile(path.join(root, "blobs", file.digest));
            if (bytes.length !== file.size)
              return yield* new SetupProfileError({ reason: "invalid" });
            yield* packages.put(bytes, file.digest);
          }
        const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        yield* store.publish(
          { ...original, id, ownerEnvironmentId: yield* environment.getEnvironmentId, revision: 1 },
          0,
        );
        yield* Console.log(id);
      }),
      true,
    ),
  ),
);
export const setupCommand = Command.make("setup").pipe(
  Command.withDescription("Inspect and back up environment setup profiles."),
  Command.withSubcommands([status, exportProfile, restore]),
);
