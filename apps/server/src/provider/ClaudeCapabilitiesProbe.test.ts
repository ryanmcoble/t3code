// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeWorkspaceSnapshot,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps authenticated subscription usage when the API takes longer than a local probe",
  () =>
    Effect.gen(function* () {
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      let deliverUsage!: (value: {
        rate_limits_available: boolean;
        rate_limits: { five_hour: { utilization: number; resets_at: string } };
      }) => void;
      const usage = new Promise<{
        rate_limits_available: boolean;
        rate_limits: { five_hour: { utilization: number; resets_at: string } };
      }>((resolve) => {
        deliverUsage = resolve;
      });
      vi.mocked(claudeQuery).mockReturnValue({
        initializationResult: async () => ({
          account: { tokenSource: "oauth", subscriptionType: "team" },
          commands: [],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          notifyStarted();
          return usage;
        },
        close: () => {},
      } as unknown as ReturnType<typeof claudeQuery>);
      const probe = yield* Effect.forkChild(
        probeClaudeCapabilities(yield* decodeClaudeSettings({ binaryPath: process.execPath }), {
          HOME: "/nonexistent/t3-probe-home",
        }),
      );
      yield* Effect.promise(() => started);
      yield* TestClock.adjust("5 seconds");
      deliverUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 13, resets_at: "2026-11-18T00:00:00Z" } },
      });
      const result = yield* Fiber.join(probe);
      assert.equal(result.usage?.rate_limits_available, true);
      assert.equal(result.tokenSource, "oauth");
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => vi.mocked(claudeQuery).mockReset())),
    ),
);
