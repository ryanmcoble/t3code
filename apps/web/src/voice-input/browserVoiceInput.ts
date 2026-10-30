import {
  VoiceInputController,
  VoiceTranscriptionError,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { DesktopVoiceRecorder } from "./desktopVoiceRecorder";

class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private stopped: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onFinished: (uri: string | null, error: string | null) => void) {}

  async prepareToRecordAsync() {
    this.uri = null;
    const stream = await navigator.mediaDevices
      .getUserMedia({
        audio: { channelCount: 1 },
        video: false,
      })
      .catch((error: unknown) => {
        if (
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "SecurityError")
        ) {
          throw new VoiceTranscriptionError(
            "preparation-failed",
            "Allow microphone access for T3 Code in your device or browser settings, then try again.",
          );
        }
        if (error instanceof DOMException && error.name === "NotFoundError") {
          throw new VoiceTranscriptionError(
            "unavailable",
            "No microphone was found. Connect a microphone, then try again.",
          );
        }
        throw error;
      });
    this.stream = stream;
    this.recorder = new MediaRecorder(stream);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener(
        "ended",
        () => this.onFinished(null, "The microphone was disconnected."),
        { once: true },
      );
    }
  }

  record({ forDuration }: { readonly forDuration: number }) {
    const recorder = this.recorder;
    if (!recorder) throw new Error("The microphone is not ready.");
    const chunks: Blob[] = [];
    this.stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener(
        "stop",
        () => {
          clearTimeout(this.timer);
          this.uri = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
          resolve();
        },
        { once: true },
      );
      recorder.addEventListener(
        "error",
        () => {
          clearTimeout(this.timer);
          reject(new Error("The microphone stopped recording."));
          this.onFinished(null, "The microphone stopped recording.");
        },
        { once: true },
      );
    });
    void this.stopped.catch(() => {});
    recorder.start();
    this.timer = setTimeout(() => {
      void this.stop().then(
        () => this.onFinished(this.uri, null),
        () => {},
      );
    }, forDuration * 1000);
  }

  async stop() {
    clearTimeout(this.timer);
    if (this.recorder?.state === "recording" || this.recorder?.state === "paused")
      this.recorder.stop();
    await this.stopped;
  }

  release() {
    clearTimeout(this.timer);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.recorder = null;
    this.stopped = null;
  }
}

export function createBrowserVoiceInput(input: {
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  let state: VoiceInputState = { phase: "idle", error: null, errorAction: null };
  let revision = 0;
  let owner: string | null = null;
  const listeners = new Set<() => void>();
  const onFinished = (uri: string | null, error: string | null) => {
    void controller.handleRecorderStatus({
      isFinished: !error,
      hasError: error !== null,
      error,
      url: uri,
    });
  };
  const bridge = window.desktopBridge;
  const native =
    bridge?.getClientPlatform() === "darwin" &&
    typeof bridge.voiceInput?.prepareRecording === "function" &&
    typeof bridge.voiceInput?.finishRecording === "function" &&
    typeof bridge.voiceInput?.cancelRecording === "function";
  const recorder = native
    ? new DesktopVoiceRecorder(bridge.voiceInput, onFinished)
    : new BrowserVoiceRecorder(onFinished);
  const controller = new VoiceInputController({
    ...input,
    readDraft: () => {
      const draft = input.readDraft();
      return draft ? { ...draft, revision } : null;
    },
    recorder,
    requestPermission: async () => {
      if (native) return { granted: true, canAskAgain: true };
      const permission = await navigator.permissions
        ?.query({ name: "microphone" as PermissionName })
        .catch(() => null);
      return {
        granted: permission?.state !== "denied",
        canAskAgain: permission?.state !== "denied",
      };
    },
    configureRecording: async () => {},
    releaseRecording: async () => {
      await recorder.release();
    },
    deleteRecording: (uri) => URL.revokeObjectURL(uri),
    onStateChange: (next) => {
      state = next;
      for (const listener of listeners) listener();
    },
  });
  return {
    setOwner: (key: string) => {
      if (owner !== key) {
        controller.ownerChanged();
        owner = key;
      }
    },
    releaseOwner: (key: string) => {
      if (owner === key) {
        controller.dispose();
        owner = null;
      }
    },
    draftChanged: (key: string) => {
      if (key === owner) revision++;
    },
    controller,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
