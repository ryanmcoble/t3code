import { expect, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type AuthEnvironmentScope,
  EnvironmentId,
  SharedProjectError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";
import * as SharedProjects from "../../../project/SharedProjects.ts";
import * as SharedProjectEnrollment from "../../../project/SharedProjectEnrollment.ts";
import * as SharedProjectContentReplica from "../../../project/SharedProjectContentReplica.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { layerSharedProjectToolkit } from "../../McpHttpServer.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "project-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "project-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
it.effect(
  "requires the actual settings grant before reading mappings or configuring a project",
  () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const writes = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (allowed: boolean, name: string, args: Record<string, unknown>) =>
          server.callTool({ name, arguments: args }).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("host"),
              requestNamespace: "test",
              capabilities: new Set(["orchestration"] as const),
              issuedAt: 0,
              thread: undefined,
              client: {
                sessionId: "client",
                label: "Test",
                access: "full-access",
                scopes: allowed ? [AuthSettingsWriteScope] : [],
              },
            }),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const denied = yield* call(false, "t3_shared_projects", {});
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied.content)).toContain("settings:write");
        expect(yield* Ref.get(reads)).toBe(0);
        const read = yield* call(true, "t3_shared_projects", {});
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toEqual({
          projects: [],
          bindings: [],
          complete: true,
          enrollment: { subscriptions: [], complete: true },
        });
        const subscriptionArgs = {
          command: { operation: "pause", sharedProjectId: "sample", paused: true },
        };
        const deniedSubscription = yield* call(
          false,
          "t3_shared_project_subscription",
          subscriptionArgs,
        );
        expect(deniedSubscription.isError).toBe(true);
        expect(yield* Ref.get(writes)).toBe(0);
        const controlled = yield* call(true, "t3_shared_project_subscription", subscriptionArgs);
        expect(controlled.isError).not.toBe(true);
        expect(yield* Ref.get(writes)).toBe(1);
        const args = {
          command: { operation: "unbind", sharedProjectId: "sample", expectedBindingRevision: 1 },
        };
        const deniedWrite = yield* call(false, "t3_shared_project_configure", args);
        expect(deniedWrite.isError).toBe(true);
        expect(yield* Ref.get(writes)).toBe(1);
        const write = yield* call(true, "t3_shared_project_configure", args);
        expect(write.isError).toBe(true);
        expect(JSON.stringify(write.content)).toContain("revision");
        expect(yield* Ref.get(writes)).toBe(2);
      }).pipe(
        Effect.provide(
          layerSharedProjectToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(
              Layer.mock(SharedProjects.SharedProjects)({
                state: Ref.update(reads, (value) => value + 1).pipe(
                  Effect.as({ projects: [], bindings: [], complete: true }),
                ),
                unbind: () =>
                  Ref.update(writes, (value) => value + 1).pipe(
                    Effect.andThen(Effect.fail(new SharedProjectError({ reason: "revision" }))),
                  ),
              }),
            ),
            Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
            Layer.provide(Layer.mock(SharedProjectContentReplica.SharedProjectContentReplica)({})),
            Layer.provide(
              Layer.mock(SharedProjectEnrollment.SharedProjectEnrollment)({
                state: Effect.succeed({ subscriptions: [], complete: true }),
                command: () => Ref.update(writes, (value) => value + 1),
              }),
            ),
            Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          ),
        ),
      );
    }),
);

it.effect("checks file scopes before inspecting conflicts or applying a recovery command", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const writes = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (
        scopes: ReadonlyArray<AuthEnvironmentScope>,
        name: string,
        args: Record<string, unknown>,
        access: "full-access" | "read-only" = "full-access",
      ) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("host"),
            requestNamespace: "test",
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 0,
            thread: undefined,
            client: { sessionId: "client", label: "Test", access, scopes },
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const state = { query: { operation: "state", sharedProjectId: "sample" } };
      expect((yield* call([], "t3_shared_project_files", state)).isError).toBe(true);
      expect(
        (yield* call([AuthSettingsWriteScope], "t3_shared_project_files", state)).structuredContent,
      ).toEqual({ roots: [] });
      const conflicts = {
        query: { operation: "conflicts", sharedProjectId: "sample", rootId: "docs", cursor: 0 },
      };
      for (const scopes of [
        [AuthSettingsWriteScope],
        [AuthFilesystemReadScope],
        [AuthSettingsWriteScope, AuthFilesystemWriteScope],
      ]) {
        expect((yield* call(scopes, "t3_shared_project_files", conflicts)).isError).toBe(true);
      }
      expect(yield* Ref.get(reads)).toBe(0);
      const page = yield* call(
        [AuthSettingsWriteScope, AuthFilesystemReadScope],
        "t3_shared_project_files",
        conflicts,
      );
      expect(page.structuredContent).toEqual({
        generation: 4,
        paths: ["notes.md"],
        nextCursor: null,
        total: 1,
      });
      expect(yield* Ref.get(reads)).toBe(1);
      for (const command of [
        { operation: "refresh", sharedProjectId: "sample", rootId: "docs" },
        {
          operation: "resolve",
          sharedProjectId: "sample",
          rootId: "docs",
          expectedGeneration: 4,
          choice: "owner",
        },
      ]) {
        for (const scopes of [
          [AuthSettingsWriteScope],
          [AuthFilesystemWriteScope],
          [AuthSettingsWriteScope, AuthFilesystemReadScope],
        ])
          expect(
            (yield* call(scopes, "t3_shared_project_files_prepare", { command })).isError,
          ).toBe(true);
        expect(
          (yield* call(
            [AuthSettingsWriteScope, AuthFilesystemWriteScope],
            "t3_shared_project_files_prepare",
            { command },
            "read-only",
          )).isError,
        ).toBe(true);
      }
      expect(yield* Ref.get(writes)).toBe(0);
      const applied = yield* call(
        [AuthSettingsWriteScope, AuthFilesystemWriteScope],
        "t3_shared_project_files_prepare",
        {
          command: {
            operation: "resolve",
            sharedProjectId: "sample",
            rootId: "docs",
            expectedGeneration: 4,
            choice: "owner",
          },
        },
      );
      expect(applied.structuredContent).toEqual({ roots: [] });
      expect(yield* Ref.get(writes)).toBe(1);
    }).pipe(
      Effect.provide(
        layerSharedProjectToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(Layer.mock(SharedProjects.SharedProjects)({})),
          Layer.provide(Layer.mock(SharedProjectEnrollment.SharedProjectEnrollment)({})),
          Layer.provide(
            Layer.mock(SharedProjectContentReplica.SharedProjectContentReplica)({
              state: () => Effect.succeed({ roots: [] }),
              conflictPage: () =>
                Ref.update(reads, (value) => value + 1).pipe(
                  Effect.as({ generation: 4, paths: ["notes.md"], nextCursor: null, total: 1 }),
                ),
              command: () => Ref.update(writes, (value) => value + 1),
            }),
          ),
          Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        ),
      ),
    );
  }),
);
