import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_LEVEL_HISTORY,
  getVoiceLevels,
  levelFromRms,
  pushVoiceLevel,
  resetVoiceLevels,
  subscribeVoiceLevels,
} from "./voiceLevels";

describe("voiceLevels", () => {
  it("maps RMS to the native recorder's 0...1 scale with a -50 dBFS floor", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(10 ** (-60 / 20))).toBe(0);
    expect(levelFromRms(10 ** (-25 / 20))).toBeCloseTo(0.5, 5);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(Number.NaN)).toBe(0);
  });

  it("keeps a fixed-length, clamped history with the newest sample last", () => {
    resetVoiceLevels();
    expect(getVoiceLevels()).toHaveLength(VOICE_LEVEL_HISTORY);
    expect(getVoiceLevels().every((level) => level === 0)).toBe(true);

    let notified = 0;
    const unsubscribe = subscribeVoiceLevels(() => notified++);
    pushVoiceLevel(0.25);
    pushVoiceLevel(2);
    pushVoiceLevel(-1);
    const levels = getVoiceLevels();
    expect(levels).toHaveLength(VOICE_LEVEL_HISTORY);
    expect(levels.slice(-3)).toEqual([0.25, 1, 0]);
    expect(notified).toBe(3);

    for (let i = 0; i < VOICE_LEVEL_HISTORY * 2; i++) pushVoiceLevel(0.5);
    expect(getVoiceLevels()).toHaveLength(VOICE_LEVEL_HISTORY);
    expect(getVoiceLevels().every((level) => level === 0.5)).toBe(true);

    resetVoiceLevels();
    expect(getVoiceLevels().every((level) => level === 0)).toBe(true);
    unsubscribe();
    pushVoiceLevel(1);
    expect(notified).toBe(3 + VOICE_LEVEL_HISTORY * 2 + 1);
    resetVoiceLevels();
  });
});
