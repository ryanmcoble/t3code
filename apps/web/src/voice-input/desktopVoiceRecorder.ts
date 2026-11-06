import type { DesktopBridge } from "@t3tools/contracts";
import { VoiceTranscriptionError, type VoiceRecorder } from "@t3tools/client-runtime/voice-input";
import { randomUUID } from "~/lib/utils";
import { pushVoiceLevel, resetVoiceLevels } from "./voiceLevels";

export class DesktopVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private id: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detachAbort: (() => void) | undefined;
  private detachLevels: (() => void) | undefined;

  constructor(
    private readonly bridge: DesktopBridge["voiceInput"],
    private readonly onFinished: (uri: string | null, error: string | null) => void,
    private readonly getOptions: () => { readonly duckOtherAudio?: boolean } = () => ({}),
  ) {}

  async prepareToRecordAsync(options?: { readonly signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    const id = randomUUID();
    this.id = id;
    this.uri = null;
    const cancel = () => {
      void this.bridge.cancelRecording(id).catch(() => {});
    };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    this.detachAbort = () => options?.signal?.removeEventListener("abort", cancel);
    try {
      const recording = this.getOptions();
      await (recording.duckOtherAudio
        ? this.bridge.prepareRecording(id, { duckOtherAudio: true })
        : this.bridge.prepareRecording(id));
      options?.signal?.throwIfAborted();
    } catch (cause) {
      throw new VoiceTranscriptionError(
        "preparation-failed",
        cause instanceof Error ? cause.message : "Could not start the microphone.",
      );
    }
  }

  record({ forDuration }: { readonly forDuration: number }) {
    const id = this.id;
    this.detachLevels?.();
    resetVoiceLevels();
    this.detachLevels = this.bridge.onRecordingLevel?.((event) => {
      if (event.id === id) pushVoiceLevel(event.level);
    });
    this.timer = setTimeout(() => {
      void this.stop().then(
        () => this.onFinished(this.uri, null),
        (cause: unknown) =>
          this.onFinished(
            null,
            cause instanceof Error ? cause.message : "Voice recording stopped.",
          ),
      );
    }, forDuration * 1000);
  }

  private stopLevels() {
    this.detachLevels?.();
    this.detachLevels = undefined;
    resetVoiceLevels();
  }

  async stop() {
    clearTimeout(this.timer);
    this.stopLevels();
    if (!this.id) return;
    const audio = await this.bridge.finishRecording(this.id);
    this.uri = URL.createObjectURL(new Blob([new Uint8Array(audio)], { type: "audio/wav" }));
  }

  async release() {
    clearTimeout(this.timer);
    this.stopLevels();
    this.detachAbort?.();
    this.detachAbort = undefined;
    const id = this.id;
    this.id = null;
    if (id) await this.bridge.cancelRecording(id).catch(() => {});
  }
}
