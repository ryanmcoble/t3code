import type { DesktopVoiceInputRequest, VoiceInputSettings } from "@t3tools/contracts";
import { randomUUID } from "~/lib/utils";
import {
  encodeVoiceWav,
  listVoiceServerModels,
  transcribeOnVoiceServer,
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
  voiceServerUrl,
} from "@t3tools/client-runtime/voice-input";

function voiceInputLocale(settings: VoiceInputSettings): string {
  return settings.language.trim() || window.desktopBridge?.getSystemLocale() || navigator.language;
}

async function runDesktopVoiceInput(
  request: Omit<DesktopVoiceInputRequest, "id">,
  signal: AbortSignal,
) {
  throwIfVoiceTranscriptionAborted(signal);
  const bridge = window.desktopBridge?.voiceInput;
  if (!bridge)
    throw new VoiceTranscriptionError(
      "unavailable",
      "Apple transcription is available in the Mac desktop app. Choose a custom server in Chat settings for this client.",
    );
  const id = randomUUID();
  const cancel = () => {
    void bridge.cancel(id).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await bridge.run({ ...request, id });
    throwIfVoiceTranscriptionAborted(signal);
    return result;
  } catch (cause) {
    throwIfVoiceTranscriptionAborted(signal);
    throw new VoiceTranscriptionError(
      "transcription-failed",
      cause instanceof Error ? cause.message : "Voice transcription failed.",
    );
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function recordingToVoiceWav(uri: string, signal: AbortSignal) {
  const data = await fetch(uri, { signal }).then((response) => response.arrayBuffer());
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(data);
    throwIfVoiceTranscriptionAborted(signal);
    return encodeVoiceWav(
      Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)),
      audio.sampleRate,
    );
  } finally {
    await context.close();
  }
}

export function createVoiceTranscriber(settings: VoiceInputSettings): VoiceTranscriber | null {
  if (settings.engine === "off") return null;
  return {
    prepare: async ({ signal }) => {
      const locale = voiceInputLocale(settings);
      if (settings.engine === "native") {
        const capabilities = await runDesktopVoiceInput(
          { action: "capabilities", settings, locale },
          signal,
        );
        if (!capabilities.available)
          throw new VoiceTranscriptionError(
            "unavailable",
            "Apple transcription is unavailable for this device or language. Choose a custom server in Chat settings.",
          );
        const prepared = await runDesktopVoiceInput(
          { action: "prepare", settings, locale },
          signal,
        );
        return {
          locale: prepared.locale,
          transcribe: async (uri, options) => {
            const audio = await recordingToVoiceWav(uri, options.signal);
            return (
              await runDesktopVoiceInput(
                { action: "transcribe", settings, locale: prepared.locale, audio },
                options.signal,
              )
            ).text;
          },
        };
      }
      if (!settings.serverUrl.trim() || !settings.model.trim())
        throw new VoiceTranscriptionError(
          "preparation-failed",
          "Set a transcription server URL and model in Chat settings.",
        );
      voiceServerUrl(settings.serverUrl, "audio/transcriptions");
      return {
        locale,
        transcribe: async (uri, options) => {
          const audio = await recordingToVoiceWav(uri, options.signal);
          if (window.desktopBridge?.voiceInput) {
            return (
              await runDesktopVoiceInput(
                { action: "transcribe", settings, locale, audio },
                options.signal,
              )
            ).text;
          }
          return transcribeOnVoiceServer(
            settings,
            new Blob([audio], { type: "audio/wav" }),
            options.signal,
          );
        },
      };
    },
  };
}

export async function testVoiceInput(settings: VoiceInputSettings, signal: AbortSignal) {
  const locale = voiceInputLocale(settings);
  if (settings.engine === "native") {
    const result = await runDesktopVoiceInput({ action: "capabilities", settings, locale }, signal);
    return result.available
      ? result.installed
        ? "Apple transcription is ready on this Mac."
        : "Supported. Apple’s language assets will download on first use."
      : "Apple transcription is unavailable for this device or language. Choose a custom server.";
  }
  const models = window.desktopBridge?.voiceInput
    ? (await runDesktopVoiceInput({ action: "test-server", settings, locale }, signal)).models
    : await listVoiceServerModels(settings, signal);
  return models.length === 0
    ? "Connected. The server currently lists no loaded models; enter the model ID to load when transcribing."
    : `Connected. Available models: ${models.join(", ")}.`;
}
