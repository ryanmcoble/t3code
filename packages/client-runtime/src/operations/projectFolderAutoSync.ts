export interface FolderSyncObservation {
  readonly revision: string;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly now: number;
}

/** Coalesces bursts, preserves edits arriving during a transfer, and retries after reconnect. */
export function createFolderSyncMonitor(input: {
  readonly synchronize: () => Promise<void>;
  readonly report: (message: string, failed?: boolean) => void;
  readonly quietMs?: number;
}) {
  let observed: string | undefined;
  let synchronized: string | undefined;
  let blocked: string | undefined;
  let quietUntil = 0;
  let running: Promise<void> | undefined;
  const reset = () => {
    observed = undefined;
    synchronized = undefined;
    blocked = undefined;
  };
  return {
    reset,
    async observe(value: FolderSyncObservation): Promise<void> {
      if (!value.ready) {
        reset();
        input.report("Waiting for both machines…");
        return;
      }
      if (observed !== value.revision) {
        observed = value.revision;
        quietUntil = value.now + (input.quietMs ?? 1500);
        blocked = undefined;
      }
      if (value.busy) {
        quietUntil = value.now + (input.quietMs ?? 1500);
        input.report("Sync paused while an agent is working.");
        return;
      }
      if (running) return running;
      if (blocked === value.revision || synchronized === value.revision) return;
      if (value.now < quietUntil) {
        input.report("Waiting for edits to settle…");
        return;
      }
      input.report("Syncing folders…");
      running = (async () => {
        try {
          await input.synchronize();
          // Keep the version from BEFORE the transfer: writes during it must trigger another pass.
          synchronized = value.revision;
          input.report("Folders are in sync.");
        } catch (cause) {
          blocked = value.revision;
          input.report(cause instanceof Error ? cause.message : "Folder sync paused.", true);
        }
      })();
      try {
        await running;
      } finally {
        running = undefined;
      }
    },
  };
}
