import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { KeybindingShortcut } from "./keybindings.ts";

export const VoiceInputSettings = Schema.Struct({
  engine: Schema.Literals(["native", "server", "off"]),
  language: Schema.String,
  serverUrl: Schema.String,
  model: Schema.String,
  apiKey: Schema.String,
  sendOnEnter: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  globalShortcut: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  shortcutMode: Schema.Literals(["toggle", "hold"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("hold" as const)),
  ),
  /** Lower the Mac's speaker/headphone volume while recording, then restore it. */
  duckOtherAudio: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type VoiceInputSettings = typeof VoiceInputSettings.Type;

export const DEFAULT_VOICE_INPUT_SETTINGS: VoiceInputSettings = {
  engine: "native",
  language: "",
  serverUrl: "",
  model: "",
  apiKey: "",
  sendOnEnter: true,
  globalShortcut: true,
  shortcutMode: "hold",
  duckOtherAudio: true,
};

/** Fraction of the current output volume kept while dictating with `duckOtherAudio`. */
export const VOICE_DUCKED_OUTPUT_FRACTION = 0.2;

export const DesktopVoiceRecordingOptions = Schema.Struct({
  duckOtherAudio: Schema.optionalKey(Schema.Boolean),
});
export type DesktopVoiceRecordingOptions = typeof DesktopVoiceRecordingOptions.Type;

export const DesktopVoiceShortcutConfig = Schema.Struct({
  ownerKey: Schema.String,
  enabled: Schema.Boolean,
  shortcut: Schema.NullOr(KeybindingShortcut),
});
export type DesktopVoiceShortcutConfig = typeof DesktopVoiceShortcutConfig.Type;
export const DesktopVoiceShortcutEvent = Schema.Struct({
  ownerKey: Schema.String,
  type: Schema.Literals(["pressed", "released", "failed"]),
  message: Schema.optionalKey(Schema.String),
});
export type DesktopVoiceShortcutEvent = typeof DesktopVoiceShortcutEvent.Type;

export const DesktopVoiceInputRequest = Schema.Struct({
  id: Schema.String,
  action: Schema.Literals(["capabilities", "prepare", "transcribe", "test-server"]),
  settings: VoiceInputSettings,
  locale: Schema.String,
  audio: Schema.optionalKey(Schema.Uint8Array),
});
export type DesktopVoiceInputRequest = typeof DesktopVoiceInputRequest.Type;

export const DesktopVoiceInputResult = Schema.Struct({
  available: Schema.Boolean,
  locale: Schema.String,
  installed: Schema.Boolean,
  text: Schema.String,
  models: Schema.Array(Schema.String),
});
export type DesktopVoiceInputResult = typeof DesktopVoiceInputResult.Type;
