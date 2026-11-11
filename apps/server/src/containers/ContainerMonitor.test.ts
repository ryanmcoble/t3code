import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { ContainerRecord } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ContainerMonitor from "./ContainerMonitor.ts";
import * as DockerAdapter from "./DockerAdapter.ts";

const withMonitor = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  adapter: DockerAdapter.DockerAdapter["Service"],
) =>
  program.pipe(
    Effect.provide(
      ContainerMonitor.layer.pipe(
        Layer.provide(Layer.succeed(DockerAdapter.DockerAdapter, adapter)),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        ),
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
        ),
        Layer.provide(Sqlite.layerMemory),
        Layer.provide(NodeServices.layer),
        Layer.fresh,
      ),
    ),
  );

it.effect("shares one live collector and stops after the final subscriber releases", () =>
  Effect.gen(function* () {
    const samples = yield* Ref.make(0);
    yield* withMonitor(
      Effect.gen(function* () {
        const monitor = yield* ContainerMonitor.ContainerMonitor;
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        const first = yield* monitor.subscribe.pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* first.changes.pipe(Stream.runHead);
        const second = yield* monitor.subscribe.pipe(
          Effect.provideService(Scope.Scope, secondScope),
        );
        assert.equal(second.latest.engineId, "engine-a");
        assert.equal(yield* Ref.get(samples), 1);
        yield* Scope.close(firstScope, Exit.void);
        yield* TestClock.adjust("5 seconds");
        const next = yield* second.changes.pipe(Stream.runHead);
        assert.isTrue(Option.isSome(next));
        assert.equal(yield* Ref.get(samples), 2);
        yield* Scope.close(secondScope, Exit.void);
        yield* TestClock.adjust("15 seconds");
        assert.equal(yield* Ref.get(samples), 2);
        const reopenedScope = yield* Scope.make();
        const reopened = yield* monitor.subscribe.pipe(
          Effect.provideService(Scope.Scope, reopenedScope),
        );
        assert.isTrue(reopened.latest.stale);
        yield* Scope.close(reopenedScope, Exit.void);
      }),
      {
        inventory: Ref.update(samples, (value) => value + 1).pipe(
          Effect.as({
            engineId: "engine-a",
            engineName: "Local",
            complete: true,
            containers: [],
            message: "Current",
          }),
        ),
        logs: () => Effect.succeed({ text: "", truncated: false }),
      },
    );
  }),
);

it.effect(
  "keeps stack links across recreation, permits exact exceptions and removes orphan rules",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped();
      const folder = yield* fs.realPath(temporary);
      const original: ContainerRecord = {
        id: "a".repeat(64),
        name: "api-old",
        image: "api:local",
        state: "running",
        available: true,
        health: null,
        restartCount: 0,
        startedAt: null,
        finishedAt: null,
        composeProject: "api",
        composeService: "web",
        composePaths: [],
        composeConfigFiles: [`${folder}/compose.yaml`],
        bindSources: [],
        ports: [],
        cpuPercent: null,
        memoryBytes: null,
        associations: [],
      };
      const containers = yield* Ref.make<ReadonlyArray<ContainerRecord>>([original]);
      yield* withMonitor(
        Effect.gen(function* () {
          const monitor = yield* ContainerMonitor.ContainerMonitor;
          yield* monitor.associate({
            engineId: "engine-a",
            containerId: original.id,
            folder,
            operation: "include",
            scope: "stack",
          });
          const linked = yield* monitor.refresh;
          assert.equal(linked.associationRules?.length, 1);
          assert.equal(linked.containers[0]?.associations[0]?.scope, "stack");
          const replacement = { ...original, id: "b".repeat(64), name: "api-new" };
          yield* Ref.set(containers, [replacement]);
          assert.equal((yield* monitor.refresh).containers[0]?.associations[0]?.folder, folder);
          yield* monitor.associate({
            engineId: "engine-a",
            containerId: replacement.id,
            folder,
            operation: "exclude",
          });
          const excluded = yield* monitor.refresh;
          assert.equal(excluded.containers[0]?.associations.length, 0);
          assert.equal(excluded.associationRules?.length, 2);
          yield* monitor.associate({
            engineId: "engine-a",
            containerId: replacement.id,
            folder,
            operation: "remove",
          });
          assert.equal((yield* monitor.refresh).containers[0]?.associations[0]?.scope, "stack");
          yield* Ref.set(containers, []);
          const removed = yield* monitor.refresh;
          assert.equal(removed.associationRules?.length, 1);
          yield* monitor.associate({
            engineId: "engine-a",
            containerId: original.id,
            folder,
            operation: "remove",
            ruleId: removed.associationRules![0]!.id,
          });
          assert.equal((yield* monitor.refresh).associationRules?.length, 0);
        }),
        {
          inventory: Ref.get(containers).pipe(
            Effect.map((items) => ({
              engineId: "engine-a",
              engineName: "Local",
              complete: true,
              containers: items,
              message: "Current",
            })),
          ),
          logs: () => Effect.succeed({ text: "", truncated: false }),
        },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels an in-flight collection when the final view closes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    yield* withMonitor(
      Effect.gen(function* () {
        const monitor = yield* ContainerMonitor.ContainerMonitor;
        const scope = yield* Scope.make();
        yield* monitor.subscribe.pipe(Effect.provideService(Scope.Scope, scope));
        yield* Deferred.await(started);
        yield* Scope.close(scope, Exit.void);
        yield* Deferred.await(stopped);
      }),
      {
        inventory: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
        logs: () => Effect.succeed({ text: "", truncated: false }),
      },
    );
  }),
);

it.effect(
  "preserves the previous sample time and marks cached data stale when Docker goes away",
  () =>
    Effect.gen(function* () {
      const available = yield* Ref.make(true);
      yield* withMonitor(
        Effect.gen(function* () {
          const monitor = yield* ContainerMonitor.ContainerMonitor;
          const current = yield* monitor.refresh;
          assert.equal(current.status, "ready");
          yield* Ref.set(available, false);
          yield* TestClock.adjust("10 seconds");
          const failed = yield* monitor.refresh;
          assert.equal(failed.status, "engine-unavailable");
          assert.isTrue(failed.stale);
          assert.isFalse(failed.complete);
          assert.equal(failed.sampledAt, current.sampledAt);
        }),
        {
          inventory: Ref.get(available).pipe(
            Effect.flatMap((enabled) =>
              enabled
                ? Effect.succeed({
                    engineId: "engine-a",
                    engineName: "Local",
                    complete: true,
                    containers: [],
                    message: "Current",
                  })
                : Effect.fail(
                    new DockerAdapter.DockerAdapterError({ status: "engine-unavailable" }),
                  ),
            ),
          ),
          logs: () => Effect.succeed({ text: "", truncated: false }),
        },
      );
    }),
);
