import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as SetupProfileStore from "../setupProfiles/SetupProfileStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MemoryScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SharedMemory from "./SharedMemory.ts";

const env = EnvironmentId.make("owner");
const project = ProjectId.make("project-a");
const provider = ProviderInstanceId.make("codex-personal");
const actor: SharedMemory.MemoryActor = {
  kind: "agent",
  projectId: project,
  providerInstanceId: provider,
  threadId: ThreadId.make("thread-a"),
};
const scope: MemoryScope = {
  id: "acme",
  name: "Acme",
  kind: "company",
  projectIds: [project],
  providerInstanceIds: [provider],
  writableProviderInstanceIds: [provider],
  revision: 1,
  createdAt: "2026-01-01T00:00:00Z",
};
const note = {
  id: "finding-a",
  scopeId: scope.id,
  kind: "finding" as const,
  title: "Build command",
  content: "Run the approved alpha build.",
  source: { reference: "artifact:build-verification" },
};
const withMemory = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  options?: { readonly environmentId?: EnvironmentId; readonly client?: HttpClient.HttpClient },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const layer = SharedMemory.layer.pipe(
        Layer.provide(SetupProfileStore.layer),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(options?.environmentId ?? env),
            getDescriptor: Effect.die("not used"),
          }),
        ),
        Layer.provide(ServerConfig.layerTest(root, root)),
        Layer.provide(
          options?.client
            ? Layer.succeed(HttpClient.HttpClient, options.client)
            : FetchHttpClient.layer,
        ),
        Layer.provide(NodeServices.layer),
        Layer.fresh,
      );
      return yield* run.pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "shares attributed findings, supersedes corrections atomically, and rejects stale corrections",
  () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        yield* memory.command({ operation: "scope-save", scope, expectedRevision: 0 });
        const saved = yield* memory.write(note, actor);
        assert.equal(saved.author.providerInstanceId, provider);
        assert.equal(saved.author.environmentId, env);
        assert.deepEqual(yield* memory.write(note, actor), saved);
        const corrected = yield* memory.write(
          {
            ...note,
            id: "finding-b",
            content: "Use the verified beta build.",
            supersedes: note.id,
          },
          actor,
        );
        const result = yield* memory.query(
          { scopeId: scope.id, query: "build", tokenBudget: 4096 },
          actor,
        );
        assert.deepEqual(
          result.entries.map((e) => e.id),
          [corrected.id],
        );
        assert.equal(result.entries[0]!.source.reference, note.source.reference);
        assert.equal(result.contextKind, "evidence");
        const stale = yield* memory
          .write({ ...note, id: "stale", supersedes: note.id }, actor)
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        const history = yield* memory.exportScope(scope.id);
        assert.equal(history.entries.find((e) => e.id === note.id)?.supersededBy, corrected.id);
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "alpha", tokenBudget: 4096 }, actor))
            .entries.length,
          0,
        );
      }),
    ),
);

it.effect(
  "enforces project and provider scope boundaries, read-only policy, and the context budget",
  () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        yield* memory.command({
          operation: "scope-save",
          scope: { ...scope, writableProviderInstanceIds: [] },
          expectedRevision: 0,
        });
        yield* memory.command({
          operation: "write",
          entry: { ...note, content: "large finding ".repeat(1000) },
        });
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "", tokenBudget: 128 }, actor))
            .truncated,
          true,
        );
        const refused: ReadonlyArray<
          Effect.Effect<unknown, import("@t3tools/contracts").SharedMemoryError>
        > = [
          memory.write(note, actor),
          memory.query(
            { scopeId: scope.id, query: "", tokenBudget: 4096 },
            { ...actor, projectId: ProjectId.make("personal-project") },
          ),
          memory.query(
            { scopeId: scope.id, query: "", tokenBudget: 4096 },
            { ...actor, providerInstanceId: ProviderInstanceId.make("other-account") },
          ),
        ];
        for (const operation of refused)
          assert.equal((yield* operation.pipe(Effect.result))._tag, "Failure");
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "", tokenBudget: 8192 }, actor)).entries
            .length,
          1,
        );
      }),
    ),
);

it.effect(
  "bounds remote grants to scope, destination and access; revocation prevents later reads",
  () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        yield* memory.command({ operation: "scope-save", scope, expectedRevision: 0 });
        yield* memory.write(note, actor);
        const destination = EnvironmentId.make("destination");
        const grant = yield* memory.grant({
          scopeId: scope.id,
          destinationEnvironmentId: destination,
          access: "read",
          revoke: false,
        });
        const request = {
          operation: "query" as const,
          input: { scopeId: scope.id, query: "build", tokenBudget: 1024 },
          author: {
            kind: "agent" as const,
            environmentId: destination,
            providerInstanceId: provider,
          },
        };
        const result = yield* memory.serve(grant.token!, request);
        assert.isTrue("entries" in result);
        assert.equal(
          (yield* memory
            .serve(grant.token!, { ...request, author: { ...request.author, environmentId: env } })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* memory
            .serve(grant.token!, {
              operation: "write",
              input: { ...note, id: "remote-write" },
              author: request.author,
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        yield* memory.grant({
          scopeId: scope.id,
          destinationEnvironmentId: destination,
          access: "read",
          revoke: true,
        });
        assert.equal(
          (yield* memory.serve(grant.token!, request).pipe(Effect.result))._tag,
          "Failure",
        );
      }),
    ),
);

it.effect(
  "deletes findings from retrieval and export content, and removes a scope's complete history",
  () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        yield* memory.command({ operation: "scope-save", scope, expectedRevision: 0 });
        yield* memory.write(note, actor);
        yield* memory.command({ operation: "delete", scopeId: scope.id, entryId: note.id });
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "build", tokenBudget: 4096 }, actor))
            .entries.length,
          0,
        );
        const exported = yield* memory.exportScope(scope.id);
        assert.equal(exported.entries[0]?.content, "");
        yield* memory.command({
          operation: "scope-delete",
          scopeId: scope.id,
          expectedRevision: 1,
        });
        assert.equal((yield* memory.state).scopes.length, 0);
        assert.equal((yield* memory.exportScope(scope.id).pipe(Effect.result))._tag, "Failure");
      }),
    ),
);

const decodeWire = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SharedMemory.MemoryWireRequest),
);
it.effect(
  "a second environment sees corrections immediately and refuses an offline or changed owner before sending credentials",
  () =>
    withMemory(
      Effect.gen(function* () {
        const owner = yield* SharedMemory.SharedMemory;
        yield* owner.command({ operation: "scope-save", scope, expectedRevision: 0 });
        yield* owner.write(note, actor);
        const destination = EnvironmentId.make("destination");
        const token = (yield* owner.grant({
          scopeId: scope.id,
          destinationEnvironmentId: destination,
          access: "write",
          revoke: false,
        })).token!;
        let online = true;
        let identity: string = env;
        let authorizedRequests = 0;
        const client = HttpClient.make((request, url) =>
          Effect.gen(function* () {
            if (!online)
              return HttpClientResponse.fromWeb(request, new Response("offline", { status: 503 }));
            if (url.pathname === "/.well-known/t3/environment")
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ environmentId: identity }),
              );
            authorizedRequests++;
            if (request.body._tag !== "Uint8Array")
              return yield* Effect.die("Expected JSON request");
            const payload = yield* decodeWire(new TextDecoder().decode(request.body.body)).pipe(
              Effect.orDie,
            );
            const value = yield* owner
              .serve(request.headers.authorization?.replace(/^Bearer /, "") ?? "", payload)
              .pipe(Effect.orDie);
            return HttpClientResponse.fromWeb(request, Response.json(value));
          }),
        );
        yield* withMemory(
          Effect.gen(function* () {
            const memory = yield* SharedMemory.SharedMemory;
            const remoteProject = ProjectId.make("remote-project");
            const remoteActor = {
              ...actor,
              projectId: remoteProject,
              providerInstanceId: ProviderInstanceId.make("opencode"),
            };
            yield* memory.command({
              operation: "connect",
              token,
              binding: {
                scopeId: scope.id,
                name: scope.name,
                ownerEnvironmentId: env,
                sourceUrl: "http://127.0.0.1:8000",
                access: "write",
                projectIds: [remoteProject],
                providerInstanceIds: [remoteActor.providerInstanceId],
              },
            });
            const input = { scopeId: scope.id, query: "build", tokenBudget: 4096 };
            assert.equal((yield* memory.query(input, remoteActor)).entries[0]?.id, note.id);
            const corrected = yield* memory.write(
              {
                ...note,
                id: "remote-correction",
                content: "Use the beta build.",
                supersedes: note.id,
              },
              remoteActor,
            );
            assert.equal(corrected.author.environmentId, destination);
            assert.equal((yield* owner.query(input, actor)).entries[0]?.id, corrected.id);
            assert.equal((yield* memory.query(input, remoteActor)).entries[0]?.id, corrected.id);
            const before = authorizedRequests;
            identity = "other-owner";
            assert.equal(
              (yield* memory.query(input, remoteActor).pipe(Effect.result))._tag,
              "Failure",
            );
            assert.equal(authorizedRequests, before);
            identity = env;
            online = false;
            assert.equal(
              (yield* memory.query(input, remoteActor).pipe(Effect.result))._tag,
              "Failure",
            );
            online = true;
            yield* memory.forget({ scopeId: scope.id, entryId: corrected.id }, remoteActor);
            assert.equal((yield* owner.query(input, actor)).entries.length, 0);
            yield* memory.command({ operation: "disconnect", scopeId: scope.id });
            assert.equal((yield* memory.state).bindings.length, 0);
          }),
          { environmentId: destination, client },
        );
      }),
    ),
);

it.effect(
  "applies folder categories to new nested projects without matching siblings, escapes, exclusions or unauthorized providers",
  () =>
    withMemory(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const company = `${root}/company`;
        const nested = `${company}/repository/src`;
        const excluded = `${company}/private`;
        const sibling = `${root}/company-other`;
        const outside = `${root}/outside`;
        for (const directory of [nested, excluded, sibling, outside])
          yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.symlink(outside, `${company}/linked-outside`);
        const alias = `${root}/company-alias`;
        yield* fs.symlink(company, alias);
        const memory = yield* SharedMemory.SharedMemory;
        yield* memory.command({
          operation: "scope-save",
          expectedRevision: 0,
          scope: {
            ...scope,
            projectIds: [],
            rules: [
              { kind: "folder", path: alias, descendants: true, exclusions: [`${alias}/private`] },
            ],
          },
        });
        const canonicalCompany = yield* fs.realPath(company);
        assert.deepEqual((yield* memory.state).scopes[0]?.rules?.[0], {
          kind: "folder",
          path: canonicalCompany,
          descendants: true,
          exclusions: [`${canonicalCompany}/private`],
        });
        yield* memory.command({ operation: "write", entry: note });
        const newActor = {
          ...actor,
          projectId: ProjectId.make("new-project"),
          cwd: nested,
          projectRoot: `${company}/repository`,
        };
        assert.equal((yield* memory.available(newActor))[0]?.id, scope.id);
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "build", tokenBudget: 2048 }, newActor))
            .entries[0]?.id,
          note.id,
        );
        for (const cwd of [excluded, sibling, `${company}/linked-outside`, `${root}/missing`]) {
          assert.deepEqual(yield* memory.available({ ...newActor, cwd, projectRoot: cwd }), []);
        }
        assert.deepEqual(
          yield* memory.available({
            ...newActor,
            providerInstanceId: ProviderInstanceId.make("other-provider"),
          }),
          [],
        );
        yield* memory.command({
          operation: "scope-save",
          expectedRevision: 1,
          scope: {
            ...scope,
            revision: 2,
            projectIds: [],
            rules: [{ kind: "folder", path: company, descendants: false, exclusions: [] }],
          },
        });
        assert.deepEqual(yield* memory.available(newActor), []);
        assert.equal((yield* memory.available({ ...newActor, cwd: company }))[0]?.id, scope.id);
      }),
    ),
);

it.effect(
  "recalls before model tool choice with a shared budget, pinned preferences, corrections, expiry and temporary-thread controls",
  () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        const contracts = yield* Effect.promise(() => import("@t3tools/contracts"));
        const providers = ["codex", "claude", "openrouter-claude", "opencode", "copilot"].map(
          (value) => ProviderInstanceId.make(value),
        );
        yield* memory.command({
          operation: "scope-save",
          expectedRevision: 0,
          scope: {
            ...scope,
            providerInstanceIds: providers,
            writableProviderInstanceIds: providers,
          },
        });
        yield* memory.command({
          operation: "settings-save",
          expectedRevision: 0,
          settings: {
            ...contracts.DEFAULT_MEMORY_SETTINGS,
            revision: 1,
            recallEnabled: true,
            tokenBudget: 1024,
          },
        });
        yield* memory.command({
          operation: "write",
          entry: {
            ...note,
            kind: "preference",
            pinned: true,
            content: "Use inexpensive harness smoke tests.",
          },
        });
        yield* memory.command({
          operation: "write",
          entry: { ...note, id: "expired", expiresAt: "1960-01-01T00:00:00Z" },
        });
        for (const providerInstanceId of providers) {
          const context = {
            threadId: actor.threadId,
            projectId: project,
            providerInstanceId,
            cwd: "/unresolved",
            projectRoot: "/unresolved",
          };
          const text = yield* memory.recall({
            id: `recall-${providerInstanceId}`,
            context,
            text: "An unrelated task",
          });
          assert.include(text, "Use inexpensive harness smoke tests.");
          assert.notInclude(text, '"expired"');
          const receipt = (yield* memory.state).receipts?.find(
            (value) => value.id === `recall-${providerInstanceId}`,
          );
          assert.equal(receipt?.categories[0]?.id, scope.id);
          assert.isAtMost(receipt!.estimatedTokens, 1024);
        }
        yield* memory.command({
          operation: "write",
          entry: {
            ...note,
            id: "fixed",
            pinned: true,
            content: "Use the least expensive compatible smoke-test model.",
            supersedes: note.id,
          },
        });
        const context = {
          threadId: actor.threadId,
          projectId: project,
          providerInstanceId: providers[0]!,
          cwd: "/unresolved",
          projectRoot: "/unresolved",
        };
        const corrected = yield* memory.recall({ id: "corrected", context, text: "smoke" });
        assert.include(corrected, "least expensive compatible");
        assert.notInclude(corrected, "Use inexpensive harness smoke tests.");
        yield* memory.command({
          operation: "thread-policy-save",
          policy: { threadId: actor.threadId, recall: false, learn: false },
        });
        assert.equal(yield* memory.recall({ id: "private", context, text: "smoke" }), "");
        assert.equal(
          (yield* memory.state).receipts?.find((value) => value.id === "private")?.status,
          "disabled",
        );
      }),
    ),
);

it.effect(
  "queues bounded local extraction, reviews supported suggestions, deduplicates retries and enforces a daily reservation",
  () => {
    let calls = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++;
        assert.equal(request.url, "http://127.0.0.1:11434/api/chat");
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag === "Uint8Array")
          assert.include(new TextDecoder().decode(request.body.body), '"think":false');
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            message: {
              content: JSON.stringify({
                memories: [
                  {
                    kind: "preference",
                    title: "Handoffs",
                    content: "User prefers short handoffs.",
                    quote: "I prefer short handoffs.",
                  },
                  {
                    kind: "preference",
                    title: "Unsupported",
                    content: "User prefers premium models.",
                    quote: "I prefer premium models.",
                  },
                ],
              }),
            },
          }),
        );
      }),
    );
    return withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        const { DEFAULT_MEMORY_SETTINGS } = yield* Effect.promise(
          () => import("@t3tools/contracts"),
        );
        yield* memory.command({ operation: "scope-save", scope, expectedRevision: 0 });
        yield* memory.command({
          operation: "settings-save",
          expectedRevision: 0,
          settings: {
            ...DEFAULT_MEMORY_SETTINGS,
            revision: 1,
            learningMode: "suggest",
            extractorModel: "local-fixture",
            maxDailyTokens: 8704,
          },
        });
        const context = {
          threadId: actor.threadId,
          projectId: project,
          providerInstanceId: provider,
          cwd: "/unresolved",
          projectRoot: "/unresolved",
        };
        const job = { id: "run-capture", context, text: "I prefer short handoffs." };
        yield* memory.capture(job);
        yield* memory.capture(job);
        yield* memory.processCaptureJobs;
        yield* memory.processCaptureJobs;
        assert.equal(calls, 1);
        const suggestions = (yield* memory.state).suggestions!;
        assert.equal(suggestions.length, 1);
        assert.include(suggestions[0]!.entry.source.reference, job.text);
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "handoffs", tokenBudget: 1024 }, actor))
            .entries.length,
          0,
        );
        yield* memory.command({
          operation: "suggestion-resolve",
          id: suggestions[0]!.id,
          accept: true,
        });
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "handoffs", tokenBudget: 1024 }, actor))
            .entries.length,
          1,
        );
        yield* memory.capture({ ...job, id: "next-run" });
        yield* memory.processCaptureJobs;
        assert.equal(calls, 1);
        yield* memory.command({
          operation: "thread-policy-save",
          policy: { threadId: actor.threadId, recall: true, learn: false },
        });
        yield* memory.processCaptureJobs;
        assert.equal(calls, 1);
        assert.deepEqual((yield* memory.state).captureUsage?.jobs, [
          { status: "cancelled", count: 1 },
          { status: "completed", count: 1 },
        ]);
        yield* memory.command({
          operation: "delete",
          scopeId: scope.id,
          entryId: suggestions[0]!.entry.id,
        });
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "handoffs", tokenBudget: 1024 }, actor))
            .entries.length,
          0,
        );
      }),
      { client },
    );
  },
);

it.effect(
  "reuses only acknowledged context and restores memories after compaction or a native-session change",
  () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        const { DEFAULT_MEMORY_SETTINGS } = yield* Effect.promise(
          () => import("@t3tools/contracts"),
        );
        yield* memory.command({ operation: "scope-save", scope, expectedRevision: 0 });
        yield* memory.command({ operation: "write", entry: { ...note, pinned: true } });
        yield* memory.command({
          operation: "settings-save",
          expectedRevision: 0,
          settings: { ...DEFAULT_MEMORY_SETTINGS, revision: 1, recallEnabled: true },
        });
        const context = {
          threadId: actor.threadId,
          projectId: project,
          providerInstanceId: provider,
          cwd: "/repo",
          projectRoot: "/repo",
        };
        const input = { context, text: "continue", contextKey: "native-session:0" };
        assert.include(yield* memory.recall({ ...input, id: "unsent" }), note.content);
        assert.include(yield* memory.recall({ ...input, id: "retry" }), note.content);
        yield* memory.acknowledgeRecall("retry");
        assert.notInclude(yield* memory.recall({ ...input, id: "reused" }), note.content);
        assert.equal((yield* memory.status(actor.threadId)).receipt?.reusedEntries, 1);
        assert.include(
          yield* memory.recall({ ...input, contextKey: "native-session:1", id: "compacted" }),
          note.content,
        );
        yield* memory.acknowledgeRecall("compacted");
        assert.include(
          yield* memory.recall({ ...input, contextKey: "new-session:0", id: "new-session" }),
          note.content,
        );
        yield* memory.forget({ scopeId: scope.id, entryId: note.id }, actor);
        assert.notInclude(yield* memory.recall({ ...input, id: "forgotten" }), note.content);
      }),
    ),
);

it.effect(
  "saves explicit remember requests without extraction, while respecting temporary and read-only threads",
  () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* SharedMemory.SharedMemory;
        yield* memory.command({ operation: "scope-save", scope, expectedRevision: 0 });
        const context = {
          threadId: actor.threadId,
          projectId: project,
          providerInstanceId: provider,
          cwd: "/repo",
          projectRoot: "/repo",
        };
        assert.include(
          yield* memory.recall({
            id: "explicit",
            context,
            text: "Remember that I prefer short handoffs.",
          }),
          "saved",
        );
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "handoffs", tokenBudget: 1024 }, actor))
            .entries.length,
          1,
        );
        yield* memory.recall({
          id: "read-only",
          context: { ...context, readOnly: true },
          text: "Remember that I prefer very detailed handoffs.",
        });
        assert.equal(
          (yield* memory.query({ scopeId: scope.id, query: "detailed", tokenBudget: 1024 }, actor))
            .entries.length,
          0,
        );
        yield* memory.command({
          operation: "thread-policy-save",
          policy: { threadId: actor.threadId, recall: false, learn: false },
        });
        yield* memory.recall({
          id: "private",
          context,
          text: "Remember that I prefer private handoffs.",
        });
        assert.equal(
          (yield* memory.query(
            { scopeId: scope.id, query: "private", tokenBudget: 1024 },
            { kind: "user" },
          )).entries.length,
          0,
        );
        assert.equal(
          (yield* memory
            .query({ scopeId: scope.id, query: "handoffs", tokenBudget: 1024 }, actor)
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal((yield* memory.write(note, actor).pipe(Effect.result))._tag, "Failure");
      }),
    ),
);

it.effect("does not choose arbitrarily between overlapping writable project categories", () =>
  withMemory(
    Effect.gen(function* () {
      const memory = yield* SharedMemory.SharedMemory;
      for (const selected of [
        scope,
        { ...scope, id: "other-project-memory", name: "Other project" },
      ])
        yield* memory.command({ operation: "scope-save", scope: selected, expectedRevision: 0 });
      assert.include(
        yield* memory.recall({
          id: "ambiguous",
          context: { ...actor, cwd: "/repo", projectRoot: "/repo" },
          text: "Remember that I prefer short handoffs.",
        }),
        "unique writable category",
      );
      for (const scopeId of [scope.id, "other-project-memory"])
        assert.equal(
          (yield* memory.query({ scopeId, query: "handoffs", tokenBudget: 1024 }, { kind: "user" }))
            .entries.length,
          0,
        );
    }),
  ),
);
