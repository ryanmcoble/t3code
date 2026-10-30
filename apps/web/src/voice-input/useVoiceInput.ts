import { use, useEffect, useState, useSyncExternalStore } from "react";
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

export function useVoiceInput(input: {
  readonly ownerKey: string;
  readonly disabled: boolean;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly subscribeDraftChanges: (onChange: () => void) => () => void;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const settings = useClientSettings((value) => value.voiceInput);
  const background = use(BackgroundThreadContext);
  const getTranscriber = useStableCallback(() => createVoiceTranscriber(settings));
  const readDraft = useStableCallback(input.readDraft);
  const commitDraft = useStableCallback(input.commitDraft);
  const subscribeDraftChanges = useStableCallback(input.subscribeDraftChanges);
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
  const toggle = useStableCallback(() => {
    if (state.phase === "recording") {
      void session.controller.stop();
      return;
    }
    if (!busy && available && !input.disabled) void session.controller.start();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases microphone and transcription work when its draft leaves the mounted composer
  useEffect(() => {
    const ownerKey = input.ownerKey;
    if (background) {
      session.releaseOwner(ownerKey);
      return;
    }
    session.setOwner(ownerKey);
    return () => session.releaseOwner(ownerKey);
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
      },
      {
        context: () => ({
          composerFocus:
            busy || Boolean(document.activeElement?.closest("[data-chat-composer-form]")),
        }),
      },
    );
  }, [available, busy, input.disabled, toggle]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes the mounted composer's dictation action to the command palette
  useEffect(() => {
    if (!available || input.disabled) return;
    return registerMenuAction("composer.dictation", toggle);
  }, [available, input.disabled, toggle]);
  return { state, available, busy, toggle, cancel: () => session.controller.cancel() };
}
