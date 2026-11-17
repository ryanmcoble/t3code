import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createMcpAppEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    apps: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:apps:list",
      tag: WS_METHODS.appsList,
    }),
    appDocument: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:apps:open",
      tag: WS_METHODS.appsOpen,
    }),
    openApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:apps:open",
      tag: WS_METHODS.appsOpen,
    }),
    saveApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:apps:save",
      tag: WS_METHODS.appsSave,
    }),
    removeApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:apps:remove",
      tag: WS_METHODS.appsRemove,
    }),
    readApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:apps:read",
      tag: WS_METHODS.appsRead,
    }),
    writeApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:apps:write",
      tag: WS_METHODS.appsWrite,
    }),
    callTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:call-tool",
      tag: WS_METHODS.mcpAppsCallTool,
    }),
    toolInfo: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:tool-info",
      tag: WS_METHODS.mcpAppsToolInfo,
    }),
    /** The tool definition an app reads from its host context. */
    toolInfoQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-apps:tool-info",
      tag: WS_METHODS.mcpAppsToolInfo,
    }),
    readResource: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:read-resource",
      tag: WS_METHODS.mcpAppsReadResource,
    }),
    updateModelContext: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:update-model-context",
      tag: WS_METHODS.mcpAppsUpdateModelContext,
    }),
  };
}
