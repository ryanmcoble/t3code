import {
  DesktopVoiceInputRequest,
  DesktopVoiceInputResult,
  DesktopVoiceShortcutConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopVoiceInput } from "../../voice-input/DesktopVoiceInput.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopVoiceShortcut from "../../voice-input/DesktopVoiceShortcut.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Option from "effect/Option";
import { DesktopVoiceInputError } from "../../voice-input/DesktopVoiceInput.ts";
import * as DesktopVoiceRecording from "../../voice-input/DesktopVoiceRecording.ts";

const ensureVoiceSender = Effect.fn("desktop.ipc.voiceInput.ensureSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id)
    return yield* new DesktopVoiceInputError({ message: "Voice recording request was rejected." });
});

export const prepareVoiceRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_RECORD_PREPARE_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voiceInput.prepareRecording")(function* (id, event) {
    yield* ensureVoiceSender(event);
    yield* (yield* DesktopVoiceRecording.DesktopVoiceRecording).prepare(id);
  }),
});
export const finishVoiceRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_RECORD_FINISH_CHANNEL,
  payload: Schema.String,
  result: Schema.Uint8Array,
  handler: Effect.fn("desktop.ipc.voiceInput.finishRecording")(function* (id, event) {
    yield* ensureVoiceSender(event);
    return yield* (yield* DesktopVoiceRecording.DesktopVoiceRecording).finish(id);
  }),
});
export const cancelVoiceRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_RECORD_CANCEL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voiceInput.cancelRecording")(function* (id, event) {
    yield* ensureVoiceSender(event);
    yield* (yield* DesktopVoiceRecording.DesktopVoiceRecording).cancel(id);
  }),
});

export const configureVoiceShortcut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_SHORTCUT_CONFIG_CHANNEL,
  payload: DesktopVoiceShortcutConfig,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voiceInput.configureShortcut")(function* (config, event) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id)
      return yield* new DesktopVoiceInputError({
        message: "The global dictation shortcut request was rejected.",
      });
    yield* (yield* DesktopVoiceShortcut.DesktopVoiceShortcut).configure(config);
  }),
});

export const runVoiceInput = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_RUN_CHANNEL,
  payload: DesktopVoiceInputRequest,
  result: DesktopVoiceInputResult,
  handler: Effect.fn("desktop.ipc.voiceInput.run")(function* (request) {
    return yield* (yield* DesktopVoiceInput).run(request);
  }),
});

export const cancelVoiceInput = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_CANCEL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voiceInput.cancel")(function* (id) {
    yield* (yield* DesktopVoiceInput).cancel(id);
  }),
});
