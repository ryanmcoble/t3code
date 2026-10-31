import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SetupProfileError,
  SetupProfile,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SetupProfiles from "./SetupProfiles.ts";
import * as SetupProfileStore from "./SetupProfileStore.ts";
import * as SetupPackages from "./SetupPackages.ts";
import * as SetupFiles from "./SetupFiles.ts";
import * as SetupRuntime from "./SetupRuntime.ts";
import { validateSetupProfile } from "./validation.ts";

const isProfile = Schema.is(SetupProfile);
const isSetupError = Schema.is(SetupProfileError);
const instanceId = ProviderInstanceId.make("claude-test");
const ownerId = EnvironmentId.make("profile-owner");

const withSetup = <A, E, R>(
  run: (root: string) => Effect.Effect<A, E, R>,
  options: { readonly environmentId?: EnvironmentId; readonly client?: HttpClient.HttpClient } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-setup-profile-" });
      const layer = SetupProfiles.layer.pipe(
        Layer.provideMerge(SetupFiles.layer),
        Layer.provideMerge(SetupPackages.layer),
        Layer.provideMerge(SetupProfileStore.layer),
        Layer.provideMerge(SetupRuntime.layer),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(
          ServerSettings.ServerSettingsService.layerTest({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: true,
                config: { homePath: `${root}/claude` },
              },
              [ProviderInstanceId.make("same-home")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: true,
                config: { homePath: `${root}/claude` },
              },
              [ProviderInstanceId.make("copilot-test")]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                enabled: true,
                config: { source: "local", commandPath: "/usr/bin/copilot", commandArgs: [] },
              },
              [ProviderInstanceId.make("copilot-registry-test")]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                enabled: true,
                config: { agentId: "github-copilot-cli" },
              },
            },
          }),
        ),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(options.environmentId ?? ownerId),
            getDescriptor: Effect.die("Descriptor is not used by local profile tests"),
          }),
        ),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provide(ServerConfig.layerTest(root, root)),
        Layer.provide(
          options.client
            ? Layer.succeed(HttpClient.HttpClient, options.client)
            : FetchHttpClient.layer,
        ),
        Layer.provide(ProcessRunner.layer),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, root)),
        Layer.provide(NodeServices.layer),
        Layer.fresh,
      );
      return yield* run(root).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("retains revisions, rejects stale publications, and restricts subscription reads", () =>
  withSetup(() =>
    Effect.gen(function* () {
      const profiles = yield* SetupProfiles.SetupProfiles;
      const state = yield* profiles.command({
        operation: "publish",
        profile: { name: "Development", expectedRevision: 0, connections: [], skills: [] },
      });
      const profile = state.profiles[0]!;
      const token = (yield* profiles.grant({
        profileId: profile.id,
        destinationEnvironmentId: EnvironmentId.make("destination"),
        revoke: false,
      })).token!;
      assert.deepEqual(
        yield* profiles.serve({ profileId: profile.id, destinationId: "destination", token }),
        profile,
      );
      const wrongDestination = yield* profiles
        .serve({ profileId: profile.id, destinationId: "someone-else", token })
        .pipe(Effect.flip);
      assert.strictEqual(wrongDestination.reason, "denied");
      yield* profiles.command({
        operation: "publish",
        profile: { ...profile, expectedRevision: 1, name: "Updated" },
      });
      const stale = yield* profiles
        .command({ operation: "publish", profile: { ...profile, expectedRevision: 1 } })
        .pipe(Effect.flip);
      assert.strictEqual(stale.reason, "conflict");
      const previous = yield* profiles.serve({
        profileId: profile.id,
        revision: 1,
        destinationId: "destination",
        token,
      });
      assert.isTrue(isProfile(previous));
      if (isProfile(previous)) assert.strictEqual(previous.name, "Development");
      yield* profiles.grant({
        profileId: profile.id,
        destinationEnvironmentId: EnvironmentId.make("destination"),
        revoke: true,
      });
      assert.strictEqual(
        (yield* profiles
          .serve({ profileId: profile.id, destinationId: "destination", token })
          .pipe(Effect.flip)).reason,
        "denied",
      );
    }),
  ),
);

it.effect(
  "installs complete skill packages and preserves local edits across update and removal",
  () =>
    withSetup((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profiles = yield* SetupProfiles.SetupProfiles;
        yield* fs.makeDirectory(`${root}/source/report/scripts`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/source/report/SKILL.md`,
          "---\nname: report\ndescription: Read the companion guide\n---\nRead guide.md.\n",
        );
        yield* fs.writeFileString(`${root}/source/report/guide.md`, "Original guide");
        yield* fs.writeFileString(`${root}/source/report/scripts/run.sh`, "echo report\n");
        const imported = yield* profiles.importSetup({
          instanceId,
          skillPaths: [`${root}/source/report`],
        });
        assert.strictEqual(imported.skills[0]!.files.length, 3);
        const published = yield* profiles.command({
          operation: "publish",
          profile: {
            name: "Development",
            expectedRevision: 0,
            connections: [],
            skills: imported.skills,
          },
        });
        const profile = published.profiles[0]!;
        yield* profiles.command({
          operation: "apply",
          profileId: profile.id,
          instanceIds: [
            instanceId,
            ProviderInstanceId.make("same-home"),
            ProviderInstanceId.make("copilot-test"),
            ProviderInstanceId.make("copilot-registry-test"),
          ],
          subscribe: true,
        });
        yield* profiles.reconcile(() => Effect.void);
        assert.isTrue(yield* fs.exists(`${root}/.copilot/skills/report/guide.md`));
        assert.equal(
          (yield* profiles.state).binding!.items.find(
            (item) => item.instanceId === "copilot-registry-test" && item.kind === "skill",
          )?.status,
          "configured",
        );
        assert.strictEqual(
          yield* fs.readFileString(`${root}/claude/skills/report/guide.md`),
          "Original guide",
        );
        yield* fs.writeFileString(`${root}/claude/skills/report/guide.md`, "My local edit");
        yield* profiles.reconcile(() => Effect.void);
        assert.include(
          (yield* profiles.state).binding!.conflicts!,
          `${root}/claude/skills/report/guide.md`,
        );
        yield* fs.writeFileString(`${root}/source/report/guide.md`, "New published guide");
        const changed = yield* profiles.importSetup({
          instanceId,
          skillPaths: [`${root}/source/report`],
        });
        yield* profiles.command({
          operation: "publish",
          profile: { ...profile, expectedRevision: 1, skills: changed.skills },
        });
        yield* profiles.reconcile(() => Effect.void);
        assert.strictEqual(
          yield* fs.readFileString(`${root}/claude/skills/report/guide.md`),
          "My local edit",
        );
        assert.include((yield* profiles.state).binding!.error!, "Local file conflicts");
        yield* profiles.command({
          operation: "resolve",
          path: `${root}/claude/skills/report/guide.md`,
          resolution: "use-profile",
        });
        yield* profiles.reconcile(() => Effect.void);
        assert.strictEqual(
          yield* fs.readFileString(`${root}/claude/skills/report/guide.md`),
          "New published guide",
        );
        yield* profiles.command({
          operation: "publish",
          profile: { ...profile, expectedRevision: 2, skills: [] },
        });
        yield* profiles.reconcile(() => Effect.void);
        assert.isFalse(yield* fs.exists(`${root}/claude/skills/report/SKILL.md`));
        assert.isNull((yield* profiles.state).binding!.error);
      }),
    ),
);

it.effect(
  "defers activation while work is active and resolves secrets only on the destination",
  () =>
    withSetup(() =>
      Effect.gen(function* () {
        const profiles = yield* SetupProfiles.SetupProfiles;
        const runtime = yield* SetupRuntime.SetupRuntime;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const sql = yield* SqlClient.SqlClient;
        const connection = {
          name: "catalog",
          transport: "http" as const,
          url: "https://example.com/mcp",
          args: [],
          environment: {},
          headers: { Authorization: { kind: "secret" as const, name: "catalog-token" } },
          drivers: [],
          enabled: true,
        };
        const missing = {
          ...connection,
          name: "missing",
          transport: "stdio" as const,
          command: "/definitely-missing/t3-canary",
          headers: {},
        };
        const published = yield* profiles.command({
          operation: "publish",
          profile: {
            name: "Development",
            expectedRevision: 0,
            connections: [connection, missing],
            skills: [],
          },
        });
        yield* profiles.command({
          operation: "apply",
          profileId: published.profiles[0]!.id,
          instanceIds: [instanceId],
          subscribe: true,
        });
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('busy', 'thread', 1, 'claudeAgent', 'running', '2026-10-31T00:00:00Z', '{}')`;
        yield* profiles.reconcile(() => Effect.void);
        assert.strictEqual((yield* profiles.state).binding!.appliedRevision, 0);
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'busy'`;
        yield* profiles.reconcile(() => Effect.void);
        assert.strictEqual((yield* profiles.state).binding!.items[0]!.status, "needs-secret");
        assert.strictEqual((yield* runtime.read(instanceId)).length, 0);
        assert.strictEqual(
          (yield* profiles.state).binding!.items[1]!.status,
          "missing-prerequisite",
        );
        yield* secrets.set("catalog-token", new TextEncoder().encode("Bearer destination-token"));
        yield* profiles.reconcile(() => Effect.void);
        assert.strictEqual(
          (yield* runtime.read(instanceId))[0]!.headers.Authorization,
          "Bearer destination-token",
        );
        assert.deepEqual(
          (yield* profiles.state).profiles[0]!.connections[0]!.headers.Authorization,
          { kind: "secret", name: "catalog-token" },
        );
        const original = (yield* profiles.state).profiles[0]!;
        yield* profiles.command({
          operation: "publish",
          profile: {
            ...original,
            expectedRevision: 1,
            connections: [{ ...connection, url: "https://next.example/mcp" }],
          },
        });
        yield* profiles.command({ operation: "detach", removeManaged: false });
        yield* runtime.replace(new Map());
        yield* profiles.restoreRuntime;
        assert.strictEqual((yield* runtime.read(instanceId))[0]!.url, connection.url);
        assert.strictEqual((yield* profiles.state).binding!.profile.revision, 1);
      }),
    ),
);

it.effect("rejects a skill link that escapes its package", () =>
  withSetup((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const packages = yield* SetupPackages.SetupPackages;
      yield* fs.makeDirectory(`${root}/source/unsafe`, { recursive: true });
      yield* fs.writeFileString(`${root}/source/unsafe/SKILL.md`, "A skill");
      yield* fs.writeFileString(`${root}/outside`, "Not part of the package");
      yield* fs.symlink(`${root}/outside`, `${root}/source/unsafe/escape`);
      const error = yield* packages.importSkill(`${root}/source/unsafe`).pipe(Effect.flip);
      assert.isTrue(isSetupError(error));
      assert.strictEqual(error.reason, "invalid");
    }),
  ),
);

it.effect(
  "catches up independent environments after an outage and checks identity before sending access",
  () =>
    withSetup((sourceRoot) =>
      Effect.gen(function* () {
        const source = yield* SetupProfiles.SetupProfiles;
        const fs = yield* FileSystem.FileSystem;
        const destinationId = EnvironmentId.make("independent-destination");
        yield* fs.makeDirectory(`${sourceRoot}/source/portable`, { recursive: true });
        yield* fs.writeFileString(
          `${sourceRoot}/source/portable/SKILL.md`,
          "---\nname: portable\ndescription: A portable skill\n---\nVersion one\n",
        );
        const imported = yield* source.importSetup({
          instanceId,
          skillPaths: [`${sourceRoot}/source/portable`],
        });
        const published = yield* source.command({
          operation: "publish",
          profile: {
            name: "Shared",
            expectedRevision: 0,
            connections: [],
            skills: imported.skills,
          },
        });
        const profile = published.profiles[0]!;
        const token = (yield* source.grant({
          profileId: profile.id,
          destinationEnvironmentId: destinationId,
          revoke: false,
        })).token!;
        let online = true;
        let identity: string = ownerId;
        let authorizedRequests = 0;
        const client = HttpClient.make((request, url) =>
          Effect.gen(function* () {
            if (!online)
              return HttpClientResponse.fromWeb(request, new Response("offline", { status: 503 }));
            if (url.pathname === "/.well-known/t3/environment")
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  environmentId: identity,
                  label: "Owner",
                  platform: { os: "darwin", arch: "arm64" },
                  serverVersion: "test",
                  capabilities: { repositoryIdentity: true, setupProfiles: 1 },
                }),
              );
            authorizedRequests++;
            const parts = url.pathname.split("/");
            const value = yield* source
              .serve({
                profileId: parts[3]!,
                destinationId: request.headers["t3-setup-destination"] ?? "",
                token: request.headers.authorization?.replace(/^Bearer /, "") ?? "",
                ...(parts[5] ? { digest: parts[5] } : {}),
                ...(url.searchParams.has("revision")
                  ? { revision: Number(url.searchParams.get("revision")) }
                  : {}),
              })
              .pipe(Effect.orDie);
            const response =
              value instanceof Uint8Array
                ? new Response(Uint8Array.from(value).buffer)
                : Response.json(value);
            return HttpClientResponse.fromWeb(request, response);
          }),
        );
        yield* withSetup(
          (destinationRoot) =>
            Effect.gen(function* () {
              const destination = yield* SetupProfiles.SetupProfiles;
              const targetFs = yield* FileSystem.FileSystem;
              yield* destination.command({
                operation: "subscribe",
                profileId: profile.id,
                ownerEnvironmentId: ownerId,
                sourceUrl: "https://owner.test",
                token,
                instanceIds: [instanceId],
              });
              yield* destination.reconcile(() => Effect.void);
              const target = `${destinationRoot}/claude/skills/portable/SKILL.md`;
              assert.include(yield* targetFs.readFileString(target), "Version one");
              online = false;
              yield* (yield* SetupRuntime.SetupRuntime).replace(new Map());
              yield* destination.restoreRuntime;
              assert.include(yield* targetFs.readFileString(target), "Version one");
              yield* fs.writeFileString(
                `${sourceRoot}/source/portable/SKILL.md`,
                "---\nname: portable\ndescription: A portable skill\n---\nVersion two\n",
              );
              const update = yield* source.importSetup({
                instanceId,
                skillPaths: [`${sourceRoot}/source/portable`],
              });
              yield* source.command({
                operation: "publish",
                profile: { ...profile, expectedRevision: 1, skills: update.skills },
              });
              yield* destination.reconcile(() => Effect.void);
              assert.include(yield* targetFs.readFileString(target), "Version one");
              assert.include((yield* destination.state).binding!.error!, "unreachable");
              online = true;
              identity = "different-environment";
              const sent = authorizedRequests;
              yield* destination.reconcile(() => Effect.void);
              assert.strictEqual(authorizedRequests, sent);
              assert.include(yield* targetFs.readFileString(target), "Version one");
              identity = ownerId;
              yield* destination.reconcile(() => Effect.void);
              assert.include(yield* targetFs.readFileString(target), "Version two");
              assert.strictEqual((yield* destination.state).binding!.appliedRevision, 2);
            }),
          { environmentId: destinationId, client },
        );
      }),
    ),
);

it.effect("recovers a completed file rename and refuses a redirected managed root", () =>
  withSetup((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const packages = yield* SetupPackages.SetupPackages;
      const files = yield* SetupFiles.SetupFiles;
      const store = yield* SetupProfileStore.SetupProfileStore;
      const directory = `${root}/native`;
      const target = `${directory}/canary/SKILL.md`;
      const original = yield* packages.put(new TextEncoder().encode("old"));
      const changed = yield* packages.put(new TextEncoder().encode("new"));
      assert.deepEqual(
        yield* files.apply("profile", [
          { path: target, root: directory, digest: original, executable: false },
        ]),
        [],
      );
      const entry = (yield* store.paths)[0]!;
      yield* store.savePath({ ...entry, pending_digest: `${changed}:r` });
      yield* fs.writeFileString(target, "new");
      assert.deepEqual(
        yield* files.apply("profile", [
          { path: target, root: directory, digest: changed, executable: false },
        ]),
        [],
      );
      assert.isNull((yield* store.paths)[0]!.pending_digest);
      yield* fs.rename(directory, `${root}/original-native`);
      yield* fs.makeDirectory(`${root}/elsewhere/canary`, { recursive: true });
      yield* fs.writeFileString(`${root}/elsewhere/canary/SKILL.md`, "private");
      yield* fs.symlink(`${root}/elsewhere`, directory);
      assert.deepEqual(
        yield* files.apply("profile", [
          { path: target, root: directory, digest: original, executable: false },
        ]),
        [target],
      );
      assert.strictEqual(yield* fs.readFileString(`${root}/elsewhere/canary/SKILL.md`), "private");
      for (const kind of ["parent", "file", "external-parent", "external-file"] as const) {
        const aliasRoot = `${root}/aliases-${kind}`;
        const skillDirectory = `${aliasRoot}/skill`;
        const skillFile = `${skillDirectory}/SKILL.md`;
        const parent = kind.endsWith("parent");
        const external = kind.startsWith("external");
        yield* fs.makeDirectory(parent ? aliasRoot : skillDirectory, {
          recursive: true,
        });
        const link = parent ? skillDirectory : skillFile;
        const missing = `${root}/removed-checkout/${kind}`;
        if (external) {
          yield* fs.makeDirectory(parent ? missing : `${root}/removed-checkout`, {
            recursive: true,
          });
          yield* fs.writeFileString(parent ? `${missing}/SKILL.md` : missing, "untouched");
        }
        yield* fs.symlink(missing, link);
        const desired = [{ path: skillFile, root: aliasRoot, digest: changed, executable: false }];
        assert.deepEqual(yield* files.apply(`aliases-${kind}`, desired), [skillFile]);
        assert.strictEqual(yield* fs.readLink(link), missing);
        yield* files.resolve(skillFile, "use-profile");
        assert.deepEqual(yield* files.apply(`aliases-${kind}`, desired), []);
        assert.strictEqual(yield* fs.readFileString(skillFile), "new");
        if (external)
          assert.strictEqual(
            yield* fs.readFileString(parent ? `${missing}/SKILL.md` : missing),
            "untouched",
          );
        const backupDirectory = parent ? aliasRoot : skillDirectory;
        const backups = (yield* fs.readDirectory(backupDirectory)).filter((name) =>
          name.startsWith(".t3-setup-link-backup-"),
        );
        assert.strictEqual(backups.length, 1);
        assert.strictEqual(yield* fs.readLink(`${backupDirectory}/${backups[0]}`), missing);
      }
      const matchingFile = `${root}/matching/SKILL.md`;
      yield* fs.makeDirectory(`${root}/matching`);
      yield* fs.writeFileString(matchingFile, "new", { mode: 0o640 });
      assert.deepEqual(
        yield* files.apply("matching-profile", [
          {
            path: matchingFile,
            root: `${root}/matching`,
            digest: changed,
            executable: false,
          },
        ]),
        [],
      );
      assert.strictEqual((yield* fs.stat(matchingFile)).mode & 0o777, 0o640);
      assert.deepEqual(
        yield* files.apply("another-profile", [
          {
            path: matchingFile,
            root: `${root}/matching`,
            digest: changed,
            executable: false,
          },
        ]),
        [matchingFile],
      );
    }),
  ),
);

it.effect("accepts a bounded toolkit while keeping individual blobs bounded", () =>
  withSetup(() =>
    Effect.gen(function* () {
      const packages = yield* SetupPackages.SetupPackages;
      const skill = (name: string) => ({
        name,
        drivers: [],
        files: [
          { path: "SKILL.md", digest: "a".repeat(64), size: 40 * 1024 ** 2, executable: false },
        ],
      });
      validateSetupProfile({ connections: [], skills: [skill("one"), skill("two")] });
      assert.throws(() =>
        validateSetupProfile({
          connections: [],
          skills: Array.from({ length: 13 }, (_, i) => skill(`tool-${i}`)),
        }),
      );
      const error = yield* packages.put(new Uint8Array(64 * 1024 ** 2 + 1)).pipe(Effect.flip);
      assert.strictEqual(error.reason, "invalid");
    }),
  ),
);
