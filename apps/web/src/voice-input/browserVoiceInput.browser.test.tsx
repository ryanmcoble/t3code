import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { encodeVoiceWav } from "@t3tools/client-runtime/voice-input";
import { render } from "../../test/render";
import { ComposerVoiceInput } from "../components/chat/ComposerVoiceInput";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { useVoiceInput } from "./useVoiceInput";

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: {
      voiceInput: {
        engine: string;
        language: string;
        serverUrl: string;
        model: string;
        apiKey: string;
      };
    }) => unknown,
  ) =>
    select({
      voiceInput: {
        engine: "server",
        language: "",
        serverUrl: "http://speech.test/v1",
        model: "local-speech-model",
        apiKey: "",
      },
    }),
}));

function ComposerHarness() {
  const [text, setText] = useState("before after");
  const [submitted, setSubmitted] = useState(false);
  const voice = useVoiceInput({
    ownerKey: "remote-environment:existing-thread",
    disabled: false,
    readDraft: () => ({
      ownerKey: "remote-environment:existing-thread",
      text,
      selection: { start: 7, end: 7 },
      revision: 0,
    }),
    subscribeDraftChanges: () => () => {},
    commitDraft: (value) => {
      setText(value);
    },
  });
  return (
    <form
      data-chat-composer-form="true"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <textarea
        aria-label="Message"
        readOnly={voice.busy}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <ComposerVoiceInput
        state={voice.state}
        disabled={false}
        onToggle={voice.toggle}
        onCancel={voice.cancel}
      />
      <button type="submit" disabled={voice.busy}>
        Send
      </button>
      {voice.state.error ? <span role="alert">{voice.state.error}</span> : null}
      {submitted ? <span>Submitted</span> : null}
    </form>
  );
}

function recorderFixture() {
  const original = globalThis.MediaRecorder;
  let active: Recorder | null = null;
  class Recorder extends EventTarget {
    readonly mimeType = "audio/wav";
    state = "inactive";
    start() {
      this.state = "recording";
      active = this;
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        const audio = encodeVoiceWav([new Float32Array(1600)], 16000);
        this.dispatchEvent(
          new BlobEvent("dataavailable", { data: new Blob([audio], { type: "audio/wav" }) }),
        );
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  globalThis.MediaRecorder = Recorder as unknown as typeof MediaRecorder;
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), { stop });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return {
    stop,
    stream,
    fail: () => {
      if (active) {
        active.state = "inactive";
        active.dispatchEvent(new Event("error"));
        active.stop();
      }
    },
    [Symbol.dispose]: () => {
      globalThis.MediaRecorder = original;
    },
  };
}

it("records on the client, transcribes WAV through the chosen server and leaves the result in an editable draft", async () => {
  using recorder = recorderFixture();
  await using screen = await render(<ComposerHarness />);
  using _permission = vi
    .spyOn(navigator.permissions, "query")
    .mockResolvedValue({ state: "granted" } as PermissionStatus);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(recorder.stream);
  const originalFetch = window.fetch.bind(window);
  using _fetch = vi.spyOn(window, "fetch").mockImplementation(async (url, options) => {
    if (String(url).startsWith("blob:")) return originalFetch(url, options);
    expect(String(url)).toBe("http://speech.test/v1/audio/transcriptions");
    const form = options?.body as FormData;
    expect(form.get("model")).toBe("local-speech-model");
    expect(form.has("language")).toBe(false);
    expect((form.get("file") as File).type).toBe("audio/wav");
    return Response.json({ text: "spoken text" });
  });
  await screen.getByRole("button", { name: "Start dictation" }).click();
  await expect.element(screen.getByRole("button", { name: "Finish dictation" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveAttribute("readonly");
  await screen.getByRole("button", { name: "Finish dictation" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("before spoken text after");
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .not.toHaveAttribute("readonly");
  await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect.element(screen.getByText("Submitted", { exact: true })).not.toBeInTheDocument();
  expect(recorder.stop).toHaveBeenCalledTimes(1);
});

it.each(["unmounted", "background"] as const)(
  "releases a microphone granted after the composer becomes %s",
  async (destination) => {
    using recorder = recorderFixture();
    await using screen = await render(
      <BackgroundThreadContext value={false}>
        <ComposerHarness />
      </BackgroundThreadContext>,
    );
    using _permission = vi
      .spyOn(navigator.permissions, "query")
      .mockResolvedValue({ state: "granted" } as PermissionStatus);
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
    await screen.getByRole("button", { name: "Start dictation" }).click();
    await vi.waitFor(() => expect(microphone).toHaveBeenCalledTimes(1));
    if (destination === "unmounted") await screen.unmount();
    else
      await screen.rerender(
        <BackgroundThreadContext value={true}>
          <ComposerHarness />
        </BackgroundThreadContext>,
      );
    grant(recorder.stream);
    await vi.waitFor(() => expect(recorder.stop).toHaveBeenCalledTimes(1));
  },
);

it("discards late audio from a recorder failure and preserves the existing draft", async () => {
  using recorder = recorderFixture();
  await using screen = await render(<ComposerHarness />);
  using _permission = vi
    .spyOn(navigator.permissions, "query")
    .mockResolvedValue({ state: "granted" } as PermissionStatus);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(recorder.stream);
  using revoke = vi.spyOn(URL, "revokeObjectURL");
  await screen.getByRole("button", { name: "Start dictation" }).click();
  await expect.element(screen.getByRole("button", { name: "Finish dictation" })).toBeVisible();
  recorder.fail();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The microphone stopped recording.");
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("before after");
  await vi.waitFor(() => expect(recorder.stop).toHaveBeenCalledTimes(1));
  expect(revoke).toHaveBeenCalledTimes(1);
});

it.each([
  [
    "NotAllowedError",
    "Allow microphone access for T3 Code in your device or browser settings, then try again.",
  ],
  ["NotFoundError", "No microphone was found. Connect a microphone, then try again."],
])("explains a microphone %s error without changing the draft", async (name, message) => {
  using recorder = recorderFixture();
  await using screen = await render(<ComposerHarness />);
  using _permission = vi
    .spyOn(navigator.permissions, "query")
    .mockResolvedValue({ state: "granted" } as PermissionStatus);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockRejectedValue(new DOMException("Audio capture failed.", name));
  await screen.getByRole("button", { name: "Start dictation" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("before after");
  expect(recorder.stop).not.toHaveBeenCalled();
});
