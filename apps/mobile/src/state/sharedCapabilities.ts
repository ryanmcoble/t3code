import { createSharedCapabilityAtoms } from "@t3tools/client-runtime/state/shared-capabilities";
import { connectionAtomRuntime } from "../connection/runtime";
export const sharedCapabilities = createSharedCapabilityAtoms(connectionAtomRuntime);
