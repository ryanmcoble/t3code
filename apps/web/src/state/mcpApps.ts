import { serverEnvironment } from "./server";
import { Atom, AsyncResult } from "effect/reactivity";
import { environmentCatalog } from "../connection/catalog";
import { createMcpAppEnvironmentAtoms } from "@t3tools/client-runtime/state/mcp-apps";

import { connectionAtomRuntime } from "../connection/runtime";

export const mcpAppEnvironment = createMcpAppEnvironmentAtoms(connectionAtomRuntime);

export const installedAppsAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) => {
    if (get(serverEnvironment.configValueAtom(environmentId))?.standaloneApps !== true) return [];
    const result = get(mcpAppEnvironment.apps({ environmentId, input: {} }));
    return AsyncResult.isSuccess(result)
      ? result.value.map((app) => ({ ...app, environmentId }))
      : [];
  }),
);
