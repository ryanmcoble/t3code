import {
  AuthDiagnosticsReadScope,
  ContainerError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ContainerMonitor from "../../../containers/ContainerMonitor.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, readCaller } from "../../threadAccess.ts";
import { ContainerToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ContainerToolkit, {
  t3_containers: McpToolAccess.reads((payload) =>
    Effect.gen(function* () {
      const input = payload.query;
      const caller = yield* readCaller();
      if (caller.scope.client) {
        if (!caller.scope.client.scopes?.includes(AuthDiagnosticsReadScope))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This MCP connection needs diagnostics:read permission to inspect Docker containers and logs.",
          });
      } else
        yield* assertFullAccess(
          caller,
          "Native container diagnostics require a full-access thread.",
        );
      const monitor = yield* ContainerMonitor.ContainerMonitor;
      if (input.operation === "logs")
        return { kind: "logs" as const, ...(yield* monitor.logs(input)) };
      const snapshot = yield* monitor.refresh;
      if (input.operation === "detail") {
        if (snapshot.stale) return yield* new ContainerError({ reason: "unavailable" });
        if (snapshot.engineId !== input.engineId)
          return yield* new ContainerError({ reason: "engine-changed" });
        const container = snapshot.containers.find((entry) => entry.id === input.containerId);
        if (!container) return yield* new ContainerError({ reason: "not-found" });
        return { kind: "detail" as const, container };
      }
      const folder =
        snapshot.folderAliases?.find((entry) => entry.path === input.folder)?.canonicalPath ??
        input.folder;
      const matching = snapshot.containers
        .filter(
          (container) =>
            (!folder || container.associations.some((link) => link.folder === folder)) &&
            (!input.state || container.state === input.state),
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      const remaining = matching.filter(
        (container) => !input.afterId || container.id > input.afterId,
      );
      const page = remaining.slice(0, input.limit ?? 30);
      return {
        kind: "list" as const,
        engineId: snapshot.engineId,
        sampledAt: snapshot.sampledAt,
        status: snapshot.status,
        stale: snapshot.stale,
        complete: snapshot.complete,
        message: snapshot.message,
        counts: snapshot.counts,
        matchedCount: matching.length,
        nextId: remaining.length > page.length ? page.at(-1)!.id : null,
        items: page.map(
          ({ id, name, image, state, health, cpuPercent, memoryBytes, associations }) => ({
            id,
            name,
            image,
            state,
            health,
            cpuPercent,
            memoryBytes,
            associations,
          }),
        ),
      };
    }),
  ),
});
