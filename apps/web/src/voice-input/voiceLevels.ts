import { useSyncExternalStore } from "react";

/** Number of recent level samples kept for the composer waveform. */
export const VOICE_LEVEL_HISTORY = 28;

const silence: ReadonlyArray<number> = Array.from({ length: VOICE_LEVEL_HISTORY }, () => 0);
let history: ReadonlyArray<number> = silence;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Records one input loudness sample (0...1) from the active recorder. */
export function pushVoiceLevel(level: number) {
  const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  history = [...history.slice(1), clamped];
  notify();
}

/** Clears the waveform when a recording starts or ends. */
export function resetVoiceLevels() {
  if (history === silence) return;
  history = silence;
  notify();
}

/** Maps a signal RMS (0...1) to the same 0...1 scale the native recorder reports (-50 dBFS floor). */
export function levelFromRms(rms: number) {
  if (!(rms > 0)) return 0;
  const decibels = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (decibels + 50) / 50));
}

/** Current level history, oldest first. */
export function getVoiceLevels() {
  return history;
}

/** Subscribe to level changes; returns an unsubscribe function. */
export function subscribeVoiceLevels(listener: () => void) {
  return subscribe(listener);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Recent input levels, oldest first. */
export function useVoiceLevels() {
  return useSyncExternalStore(subscribe, getVoiceLevels, () => silence);
}
