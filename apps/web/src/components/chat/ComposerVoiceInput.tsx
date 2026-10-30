import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerVoiceInput(props: {
  readonly state: VoiceInputState;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onCancel: () => void;
}) {
  const recording = props.state.phase === "recording";
  const pending = props.state.phase === "preparing" || props.state.phase === "transcribing";
  const busy = recording || pending;
  const label = recording
    ? "Finish dictation"
    : pending
      ? props.state.phase === "preparing"
        ? "Preparing voice input"
        : "Transcribing"
      : "Start dictation";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {busy ? (
        <span role="status" className="sr-only text-xs text-muted-foreground sm:not-sr-only">
          {recording
            ? "Recording"
            : props.state.phase === "preparing"
              ? "Preparing"
              : "Transcribing"}
          …
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              aria-label={label}
              aria-pressed={recording}
              disabled={props.disabled || pending}
              onClick={props.onToggle}
              onPointerDown={(event) => event.preventDefault()}
            />
          }
        >
          <ComposerControlIcon icon={recording ? SquareIcon : MicIcon} />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {busy ? (
        <ComposerControl aria-label="Cancel dictation" onClick={props.onCancel}>
          <ComposerControlIcon icon={XIcon} />
        </ComposerControl>
      ) : null}
    </div>
  );
}
