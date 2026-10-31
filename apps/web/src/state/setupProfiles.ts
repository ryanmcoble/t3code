import { createSetupProfileAtoms } from "@t3tools/client-runtime/state/setupProfiles";
import { connectionAtomRuntime } from "../connection/runtime";

export const setupProfiles = createSetupProfileAtoms(connectionAtomRuntime);
