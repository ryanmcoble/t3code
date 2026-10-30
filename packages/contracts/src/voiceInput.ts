import * as Schema from "effect/Schema";

export const VoiceInputSettings = Schema.Struct({
  engine: Schema.Literals(["native", "server", "off"]),
  language: Schema.String,
  serverUrl: Schema.String,
  model: Schema.String,
  apiKey: Schema.String,
});
export type VoiceInputSettings = typeof VoiceInputSettings.Type;

export const DEFAULT_VOICE_INPUT_SETTINGS: VoiceInputSettings = {
  engine: "native",
  language: "",
  serverUrl: "",
  model: "",
  apiKey: "",
};

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
