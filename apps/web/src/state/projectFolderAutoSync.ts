import { Atom } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";

export const folderSyncMessagesAtom = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(
  Atom.keepAlive,
);
export const folderSyncMessageKey = (environmentId: EnvironmentId, cwd: string) =>
  JSON.stringify([environmentId, cwd]);
