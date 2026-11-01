import { describe, expect, it } from "vite-plus/test";
import { createFolderSyncMonitor } from "./projectFolderAutoSync.ts";

const observation = (now: number, revision = "a", busy = false, ready = true) => ({
  now,
  revision,
  busy,
  ready,
});

describe("folder sync monitor", () => {
  it("catches up after startup, debounces changes in either direction and waits for agents", async () => {
    let runs = 0;
    const monitor = createFolderSyncMonitor({
      synchronize: async () => {
        runs++;
      },
      report: () => {},
    });
    await monitor.observe(observation(0));
    await monitor.observe(observation(1000));
    expect(runs).toBe(0);
    await monitor.observe(observation(1500));
    await monitor.observe(observation(5000));
    expect(runs).toBe(1);
    await monitor.observe(observation(6000, "local-change"));
    await monitor.observe(observation(7000, "remote-change"));
    await monitor.observe(observation(8500, "remote-change", true));
    expect(runs).toBe(1);
    await monitor.observe(observation(10000, "remote-change"));
    expect(runs).toBe(2);
    await monitor.observe(observation(11000, "remote-change", false, false));
    await monitor.observe(observation(12000, "remote-change"));
    await monitor.observe(observation(13500, "remote-change"));
    expect(runs).toBe(3);
  });

  it("serializes transfers and keeps a change that arrives while synchronizing", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const monitor = createFolderSyncMonitor({
      synchronize: async () => {
        if (++runs === 1) await gate;
      },
      report: () => {},
      quietMs: 0,
    });
    const first = monitor.observe(observation(0));
    const changed = monitor.observe(observation(1, "newer"));
    expect(runs).toBe(1);
    release();
    await Promise.all([first, changed]);
    await monitor.observe(observation(2, "newer"));
    expect(runs).toBe(2);
  });

  it("keeps conflicts paused without hammering either server, then retries after edits or reconnect", async () => {
    let runs = 0;
    const messages: string[] = [];
    const monitor = createFolderSyncMonitor({
      synchronize: async () => {
        runs++;
        throw new Error("Both versions kept");
      },
      report: (message) => messages.push(message),
      quietMs: 0,
    });
    await monitor.observe(observation(0));
    await monitor.observe(observation(1000));
    expect(runs).toBe(1);
    expect(messages.at(-1)).toBe("Both versions kept");
    await monitor.observe(observation(2000, "resolved"));
    expect(runs).toBe(2);
    monitor.reset();
    await monitor.observe(observation(3000, "resolved"));
    expect(runs).toBe(3);
  });
});
