import { DesktopVoiceInputRequest, DesktopVoiceInputResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopVoiceInput } from "../../voice-input/DesktopVoiceInput.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

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
