import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useVoiceLevels } from "~/voice-input/voiceLevels";
import { cn } from "~/lib/utils";

/** Live input level bars, newest on the right, shown while recording. */
function VoiceLevelMeter() {
  const levels = useVoiceLevels();
  return (
    <span
      aria-hidden="true"
      data-testid="composer-voice-level-meter"
      className="flex h-5 items-center gap-0.5 px-1"
    >
      {levels.map((level, index) => (
        <span
          // Bars are positional; the array shifts left as samples arrive.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className="w-[2px] rounded-full bg-foreground/70 transition-[height] duration-75 ease-out"
          style={{ height: `${Math.round(3 + Math.min(1, level * 1.4) * 15)}px` }}
        />
      ))}
    </span>
  );
}

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
      {recording ? (
        <>
          <span role="status" className="sr-only">
            Recording
          </span>
          <VoiceLevelMeter />
        </>
      ) : pending ? (
        <span role="status" className="sr-only text-xs text-muted-foreground sm:not-sr-only">
          {props.state.phase === "preparing" ? "Preparing" : "Transcribing"}…
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
              className={cn(
                recording &&
                  "rounded-full bg-destructive text-white hover:bg-destructive/90 aria-pressed:bg-destructive aria-pressed:text-white aria-pressed:hover:bg-destructive/90 [&_svg]:fill-current [&_svg]:text-white",
              )}
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
