import { expect, it } from "@effect/vitest";
import {
  AuthDiagnosticsReadScope,
  EnvironmentId,
  type ContainerRecord,
  type ContainerSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";
import * as ContainerMonitor from "../../../containers/ContainerMonitor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { layerContainerToolkit } from "../../McpHttpServer.ts";

const record: ContainerRecord = {
  id: "a".repeat(64),
  name: "api",
  image: "api:local",
  available: true,
  state: "running",
  health: null,
  restartCount: 0,
  startedAt: null,
  finishedAt: null,
  composeProject: null,
  composeService: null,
  composePaths: [],
  bindSources: [],
  ports: [],
  cpuPercent: null,
  memoryBytes: null,
  associations: [],
};
const snapshot: ContainerSnapshot = {
  engineId: "engine-a",
  engineName: "Local",
  sampledAt: 1,
  complete: true,
  stale: false,
  status: "ready",
  message: "Current",
  containers: [record, { ...record, id: "b".repeat(64), name: "db" }],
  counts: {
    total: 2,
    running: 2,
    stopped: 0,
    paused: 0,
    restarting: 0,
    removing: 0,
    unknown: 0,
    unhealthy: 0,
  },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "container-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "container-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "requires the actual diagnostics grant before collection and pages immutable container identities",
  () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (allowed: boolean, args: Record<string, unknown>) =>
          server.callTool({ name: "t3_containers", arguments: { query: args } }).pipe(
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
                scopes: allowed ? [AuthDiagnosticsReadScope] : [],
              },
            }),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const refused = yield* call(false, { operation: "list" });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain("diagnostics:read");
        expect(yield* Ref.get(reads)).toBe(0);
        const first = yield* call(true, { operation: "list", limit: 1 });
        expect(first.isError).not.toBe(true);
        expect(first.structuredContent).toMatchObject({
          nextId: record.id,
          matchedCount: 2,
          items: [{ id: record.id }],
        });
        const second = yield* call(true, { operation: "list", afterId: record.id, limit: 1 });
        expect(second.structuredContent).toMatchObject({
          nextId: null,
          items: [{ id: "b".repeat(64) }],
        });
        const wrongEngine = yield* call(true, {
          operation: "detail",
          engineId: "other-engine",
          containerId: record.id,
        });
        expect(wrongEngine.isError).toBe(true);
        expect(JSON.stringify(wrongEngine.content)).toContain("engine-changed");
      }).pipe(
        Effect.provide(
          layerContainerToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(
              Layer.mock(ContainerMonitor.ContainerMonitor)({
                refresh: Ref.update(reads, (value) => value + 1).pipe(Effect.as(snapshot)),
              }),
            ),
            Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
            Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          ),
        ),
      );
    }),
);
