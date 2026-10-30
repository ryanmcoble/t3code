import { use, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import {
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { registerCommands, registerMenuAction } from "~/shortcuts/dispatcher";
import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import { createBrowserVoiceInput } from "./browserVoiceInput";
import { createVoiceTranscriber } from "./transcriber";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { findEffectiveShortcutForCommand } from "~/keybindings";
import { randomUUID } from "~/lib/utils";

export function useVoiceInput(input: {
  readonly ownerKey: string;
  readonly disabled: boolean;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly subscribeDraftChanges: (onChange: () => void) => () => void;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly submitDraft: () => void;
}) {
  const settings = useClientSettings((value) => value.voiceInput);
  const background = use(BackgroundThreadContext);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = findEffectiveShortcutForCommand(keybindings, "composer.globalDictation", {
    context: { composerFocus: true, terminalFocus: false },
  });
  const [shortcutOwner] = useState(randomUUID);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const shortcutPressed = useRef(false);
  const heldRecording = useRef(false);
  const getTranscriber = useStableCallback(() => createVoiceTranscriber(settings));
  const readDraft = useStableCallback(input.readDraft);
  const commitDraft = useStableCallback(input.commitDraft);
  const subscribeDraftChanges = useStableCallback(input.subscribeDraftChanges);
  const submitTranscript = useStableCallback((ownerKey: string, text: string) => {
    if (background || input.disabled || input.ownerKey !== ownerKey) return;
    const current = readDraft();
    if (current?.ownerKey === ownerKey && current.text === text) input.submitDraft();
  });
  const [session] = useState(() =>
    createBrowserVoiceInput({ getTranscriber, readDraft, commitDraft }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const available =
    !background &&
    settings.engine !== "off" &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    (settings.engine === "server" || window.desktopBridge?.getClientPlatform() === "darwin");
  const busy = voiceInputBlocksSubmission(state);
  const finishAndSend = useStableCallback(async (send: boolean) => {
    heldRecording.current = false;
    const ownerKey = input.ownerKey;
    const text = await session.controller.stop();
    if (text === null || !send) return;
    // Submission must see the committed transcript and the idle controller in the same render.
    flushSync(() => {});
    if (session.getSnapshot().phase === "idle") submitTranscript(ownerKey, text);
  });
  const finishFromEnter = useStableCallback(() => finishAndSend(settings.sendOnEnter));
  const onKeyDownCapture = useStableCallback((event: KeyboardEvent) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      !(event.target instanceof Element) ||
      !event.target.closest('[data-testid="composer-editor"]') ||
      !voiceInputBlocksSubmission(session.getSnapshot())
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && session.getSnapshot().phase === "recording") void finishFromEnter();
  });
  const toggle = useStableCallback(() => {
    heldRecording.current = false;
    if (state.phase === "recording") {
      void session.controller.stop();
      return;
    }
    if (!busy && available && !input.disabled) void session.controller.start();
  });
  const cancel = useStableCallback(() => {
    heldRecording.current = false;
    shortcutPressed.current = false;
    session.controller.cancel();
  });
  const pressShortcut = useStableCallback(() => {
    if (shortcutPressed.current || !available || input.disabled) return;
    shortcutPressed.current = true;
    if (settings.shortcutMode === "hold") {
      if (voiceInputBlocksSubmission(session.getSnapshot())) return;
      heldRecording.current = true;
      void session.controller.start();
    } else toggle();
  });
  const releaseShortcut = useStableCallback(() => {
    shortcutPressed.current = false;
    if (!heldRecording.current) return;
    heldRecording.current = false;
    if (session.getSnapshot().phase === "recording") void finishAndSend(true);
    else if (session.getSnapshot().phase === "preparing") session.controller.cancel();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases microphone and transcription work when its draft leaves the mounted composer
  useEffect(() => {
    const ownerKey = input.ownerKey;
    if (background) {
      session.releaseOwner(ownerKey);
      return;
    }
    session.setOwner(ownerKey);
    return () => {
      heldRecording.current = false;
      shortcutPressed.current = false;
      session.releaseOwner(ownerKey);
    };
  }, [session, input.ownerKey, background]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes external draft changes so late transcripts cannot overwrite an edited draft
  useEffect(() => {
    if (background) return;
    const ownerKey = input.ownerKey;
    return subscribeDraftChanges(() => session.draftChanged(ownerKey));
  }, [session, input.ownerKey, subscribeDraftChanges, background]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers voice input with the app's shortcut dispatcher
  useEffect(() => {
    if (!available || input.disabled) return;
    return registerCommands(
      {
        "composer.dictation": (event) => {
          if (!available || input.disabled) return false;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) toggle();
        },
        "composer.globalDictation": (event) => {
          if (!available || input.disabled) return false;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) pressShortcut();
        },
      },
      {
        context: () => ({
          composerFocus:
            busy || Boolean(document.activeElement?.closest("[data-chat-composer-form]")),
        }),
      },
    );
  }, [available, busy, input.disabled, pressShortcut, toggle]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes release of an app-local dictation shortcut, including modifier keys released first
  useEffect(() => {
    if (!available || input.disabled || !shortcut) return;
    const release = (event: globalThis.KeyboardEvent) => {
      if (!shortcutPressed.current) return;
      const meta = shortcut.metaKey || (shortcut.modKey && /Mac/.test(navigator.platform));
      const ctrl = shortcut.ctrlKey || (shortcut.modKey && !/Mac/.test(navigator.platform));
      if (
        event.key.toLowerCase() === shortcut.key ||
        (meta && !event.metaKey) ||
        (ctrl && !event.ctrlKey) ||
        (shortcut.shiftKey && !event.shiftKey) ||
        (shortcut.altKey && !event.altKey)
      )
        releaseShortcut();
    };
    window.addEventListener("keyup", release, true);
    return () => {
      window.removeEventListener("keyup", release, true);
      if (heldRecording.current) cancel();
      shortcutPressed.current = false;
    };
  }, [available, input.disabled, shortcut, releaseShortcut, cancel]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leases the native Mac hotkey to this composer and receives events while another app has focus
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (
      !available ||
      input.disabled ||
      !settings.globalShortcut ||
      !shortcut ||
      bridge?.getClientPlatform() !== "darwin" ||
      typeof bridge.voiceInput?.configureShortcut !== "function" ||
      typeof bridge.voiceInput?.onShortcut !== "function"
    )
      return;
    let disposed = false;
    const unsubscribe = bridge.voiceInput.onShortcut((event) => {
      if (event.ownerKey !== shortcutOwner) return;
      if (event.type === "pressed") pressShortcut();
      else if (event.type === "released") releaseShortcut();
      else {
        cancel();
        setShortcutError(event.message ?? "The global dictation shortcut stopped.");
      }
    });
    void bridge.voiceInput
      .configureShortcut({ ownerKey: shortcutOwner, enabled: true, shortcut })
      .then(
        () => {
          if (!disposed) setShortcutError(null);
        },
        (cause: unknown) => {
          if (!disposed)
            setShortcutError(
              cause instanceof Error
                ? cause.message
                : "Could not register the global dictation shortcut.",
            );
        },
      );
    return () => {
      disposed = true;
      unsubscribe();
      if (heldRecording.current) cancel();
      shortcutPressed.current = false;
      void bridge.voiceInput
        .configureShortcut({ ownerKey: shortcutOwner, enabled: false, shortcut: null })
        .catch(() => {});
    };
  }, [
    available,
    input.disabled,
    settings.globalShortcut,
    shortcut,
    shortcutOwner,
    pressShortcut,
    releaseShortcut,
    cancel,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes the mounted composer's dictation action to the command palette
  useEffect(() => {
    if (!available || input.disabled) return;
    return registerMenuAction("composer.dictation", toggle);
  }, [available, input.disabled, toggle]);
  return {
    state,
    available,
    busy,
    toggle,
    onKeyDownCapture,
    shortcutError,
    cancel,
  };
}
