import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { encodeVoiceWav } from "@t3tools/client-runtime/voice-input";
import { render } from "../../test/render";
import { ComposerVoiceInput } from "../components/chat/ComposerVoiceInput";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { useVoiceInput } from "./useVoiceInput";
import { userEvent } from "vite-plus/test/browser";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../components/ComposerPromptEditorTiptap";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { __setClientSettingsForTests } from "../hooks/useSettings";
import type {
  DesktopBridge,
  DesktopVoiceShortcutConfig,
  DesktopVoiceShortcutEvent,
} from "@t3tools/contracts";

function setup(sendOnEnter = true, shortcutMode: "toggle" | "hold" = "toggle") {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    voiceInput: {
      ...DEFAULT_CLIENT_SETTINGS.voiceInput,
      engine: "server",
      serverUrl: "http://speech.test/v1",
      model: "local-speech-model",
      sendOnEnter,
      shortcutMode,
    },
  });
}

function globalShortcutFixture(
  prepare: () => Promise<void> = async () => {},
  cancel: () => void = () => {},
) {
  const original = window.desktopBridge;
  let listener: ((event: DesktopVoiceShortcutEvent) => void) | undefined;
  let ownerKey = "";
  let configured!: () => void;
  const ready = new Promise<void>((resolve) => {
    configured = resolve;
  });
  const finishRecording = vi.fn(async () => encodeVoiceWav([new Float32Array(1600)], 16000));
  window.desktopBridge = {
    getClientPlatform: () => "darwin",
    getSystemLocale: () => "en-US",
    voiceInput: {
      configureShortcut: async (config: DesktopVoiceShortcutConfig) => {
        if (config.enabled) {
          ownerKey = config.ownerKey;
          configured();
        }
      },
      onShortcut: (next: (event: DesktopVoiceShortcutEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      run: async () => ({
        available: true,
        installed: true,
        locale: "en-US",
        text: "spoken text",
        models: [],
      }),
      cancel: async () => {},
      prepareRecording: prepare,
      finishRecording,
      cancelRecording: async () => {
        cancel();
      },
    },
  } as unknown as DesktopBridge;
  return {
    ready,
    finishRecording,
    press: () => listener?.({ ownerKey, type: "pressed" }),
    release: () => listener?.({ ownerKey, type: "released" }),
    [Symbol.dispose]: () => {
      if (original) window.desktopBridge = original;
      else delete window.desktopBridge;
    },
  };
}

function ComposerHarness({
  realEditor = false,
  ownerKey = "remote-environment:existing-thread",
}: {
  readonly realEditor?: boolean;
  readonly ownerKey?: string;
}) {
  const [text, setText] = useState("before after");
  const [submitted, setSubmitted] = useState(false);
  const [sentText, setSentText] = useState("");
  const [sendCount, setSendCount] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<ComposerPromptEditorHandle>(null);
  const voice = useVoiceInput({
    ownerKey,
    disabled: false,
    readDraft: () => ({
      ownerKey,
      text,
      selection: { start: 7, end: 7 },
      revision: 0,
    }),
    subscribeDraftChanges: () => () => {},
    commitDraft: (value) => {
      setText(value);
    },
    submitDraft: () => form.current?.requestSubmit(),
  });
  return (
    <form
      ref={form}
      data-chat-composer-form="true"
      onKeyDownCapture={voice.onKeyDownCapture}
      onSubmit={(event) => {
        event.preventDefault();
        if (voice.busy) return;
        setSubmitted(true);
        setSentText(text);
        setSendCount((count) => count + 1);
      }}
    >
      {realEditor ? (
        <ComposerPromptEditorTiptap
          editorRef={editor}
          value={text}
          cursor={7}
          contextRecords={new Map()}
          skills={[]}
          disabled={voice.busy}
          placeholder="Message"
          ariaLabel="Message"
          onChange={setText}
          onPaste={() => {}}
        />
      ) : (
        <textarea
          aria-label="Message"
          data-testid="composer-editor"
          readOnly={voice.busy}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
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
      <output aria-label="Sent message">{sentText}</output>
      <output aria-label="Send count">{sendCount}</output>
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
  setup();
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
    setup();
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

it.each(["empty", "error", "cancel", "owner-change", "background"] as const)(
  "does not send a pending Enter submission after %s",
  async (outcome) => {
    setup();
    using recorder = recorderFixture();
    await using screen = await render(
      <BackgroundThreadContext value={false}>
        <ComposerHarness />
      </BackgroundThreadContext>,
    );
    using _permission = vi
      .spyOn(navigator.permissions, "query")
      .mockResolvedValue({ state: "granted" } as PermissionStatus);
    using _microphone = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(recorder.stream);
    using revoke = vi.spyOn(URL, "revokeObjectURL");
    let respond!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalFetch = window.fetch.bind(window);
    using _fetch = vi.spyOn(window, "fetch").mockImplementation((url, options) => {
      if (String(url).startsWith("blob:")) return originalFetch(url, options);
      entered();
      return response;
    });
    await screen.getByRole("textbox", { name: "Message" }).click();
    await screen.getByRole("button", { name: "Start dictation" }).click();
    await expect.element(screen.getByRole("button", { name: "Finish dictation" })).toBeVisible();
    await userEvent.keyboard("{Enter}{Enter}");
    await requestEntered;
    await expect.element(screen.getByText("Submitted", { exact: true })).not.toBeInTheDocument();
    if (outcome === "cancel")
      await screen.getByRole("button", { name: "Cancel dictation" }).click();
    if (outcome === "owner-change")
      await screen.rerender(
        <BackgroundThreadContext value={false}>
          <ComposerHarness ownerKey="another-thread" />
        </BackgroundThreadContext>,
      );
    if (outcome === "background")
      await screen.rerender(
        <BackgroundThreadContext value={true}>
          <ComposerHarness />
        </BackgroundThreadContext>,
      );
    respond(
      outcome === "error"
        ? new Response("Unavailable", { status: 503 })
        : Response.json({ text: outcome === "empty" ? " " : "late transcript" }),
    );
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    await expect.element(screen.getByRole("status", { name: "Send count" })).toHaveTextContent("0");
    await expect
      .element(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("before after");
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  },
);

it("discards late audio from a recorder failure and preserves the existing draft", async () => {
  setup();
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
  setup();
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

it.each([
  { sendOnEnter: true, realEditor: false },
  { sendOnEnter: false, realEditor: false },
  { sendOnEnter: true, realEditor: true },
])(
  "Enter finishes dictation with $sendOnEnter and real editor $realEditor",
  async ({ sendOnEnter, realEditor }) => {
    setup(sendOnEnter);
    using recorder = recorderFixture();
    await using screen = await render(<ComposerHarness realEditor={realEditor} />);
    using _permission = vi
      .spyOn(navigator.permissions, "query")
      .mockResolvedValue({ state: "granted" } as PermissionStatus);
    using _microphone = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(recorder.stream);
    const originalFetch = window.fetch.bind(window);
    using _fetch = vi.spyOn(window, "fetch").mockImplementation(async (url) => {
      if (String(url).startsWith("blob:")) return originalFetch(url);
      return Response.json({ text: "spoken text" });
    });
    await screen.getByRole("textbox", { name: "Message" }).click();
    await screen.getByRole("button", { name: "Start dictation" }).click();
    await expect.element(screen.getByRole("button", { name: "Finish dictation" })).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect.element(screen.getByRole("button", { name: "Finish dictation" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    if (realEditor)
      await expect
        .element(screen.getByRole("textbox", { name: "Message" }))
        .toHaveTextContent("before spoken text after");
    else
      await expect
        .element(screen.getByRole("textbox", { name: "Message" }))
        .toHaveValue("before spoken text after");
    if (sendOnEnter) {
      await expect
        .element(screen.getByRole("status", { name: "Sent message" }))
        .toHaveTextContent("before spoken text after");
      await expect
        .element(screen.getByRole("status", { name: "Send count" }))
        .toHaveTextContent("1");
    } else {
      await expect.element(screen.getByText("Submitted", { exact: true })).not.toBeInTheDocument();
    }
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  },
);

it.each(["toggle", "hold"] as const)(
  "receives the system-wide shortcut with %s behavior while the composer is unfocused",
  async (mode) => {
    setup(true, mode);
    using bridge = globalShortcutFixture();
    using recorder = recorderFixture();
    await using screen = await render(<ComposerHarness realEditor />);
    using _permission = vi
      .spyOn(navigator.permissions, "query")
      .mockResolvedValue({ state: "granted" } as PermissionStatus);
    using _microphone = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(recorder.stream);
    await bridge.ready;
    (document.activeElement as HTMLElement)?.blur();
    bridge.press();
    bridge.press();
    await expect.element(screen.getByRole("button", { name: "Finish dictation" })).toBeVisible();
    bridge.release();
    if (mode === "toggle") {
      await expect.element(screen.getByRole("button", { name: "Finish dictation" })).toBeVisible();
      await screen.getByRole("textbox", { name: "Message" }).click();
      await userEvent.keyboard("{Enter}");
    }
    await expect
      .element(screen.getByRole("status", { name: "Sent message" }))
      .toHaveTextContent("before spoken text after");
    await expect.element(screen.getByRole("status", { name: "Send count" })).toHaveTextContent("1");
    expect(bridge.finishRecording).toHaveBeenCalledTimes(1);
    expect(_microphone).not.toHaveBeenCalled();
  },
);

it("cancels push-to-talk released before native microphone preparation finishes", async () => {
  setup(true, "hold");
  let reject!: (cause: Error) => void;
  const permission = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const prepare = vi.fn(() => permission);
  const cancel = vi.fn(() => reject(new Error("Recording cancelled")));
  using bridge = globalShortcutFixture(prepare, cancel);
  using recorder = recorderFixture();
  await using screen = await render(<ComposerHarness />);
  using _permission = vi
    .spyOn(navigator.permissions, "query")
    .mockResolvedValue({ state: "granted" } as PermissionStatus);
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(recorder.stream);
  await bridge.ready;
  bridge.press();
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  bridge.release();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  expect(microphone).not.toHaveBeenCalled();
  expect(bridge.finishRecording).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("status", { name: "Send count" })).toHaveTextContent("0");
  await expect.element(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
});
