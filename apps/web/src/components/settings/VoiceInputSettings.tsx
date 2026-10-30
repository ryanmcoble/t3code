import { useEffect, useState } from "react";
import { useClientSettings, persistClientSettingsPatch } from "~/hooks/useSettings";
import { testVoiceInput } from "~/voice-input/transcriber";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function VoiceInputSettings() {
  const settings = useClientSettings((value) => value.voiceInput);
  const [status, setStatus] = useState<string | null>(null);
  const [operation, setOperation] = useState<AbortController | null>(null);
  const native = window.desktopBridge?.getClientPlatform() === "darwin";
  const update = (patch: Partial<typeof settings>) => {
    setStatus(null);
    operation?.abort();
    void persistClientSettingsPatch({ voiceInput: { ...settings, ...patch } });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the outstanding connection check when its settings screen unmounts
  useEffect(() => () => operation?.abort(), [operation]);
  const check = async () => {
    const controller = new AbortController();
    setOperation(controller);
    setStatus(null);
    const message = await testVoiceInput(settings, controller.signal).catch((error: unknown) =>
      error instanceof Error ? error.message : "Could not connect to the transcription server.",
    );
    if (!controller.signal.aborted) setStatus(message);
    setOperation(null);
  };
  return (
    <SettingsSection id="voice-input" title="Voice input">
      <SettingsRow
        {...searchableSetting("voice-input-engine")}
        description="Dictate into the composer. These settings apply to this client, including when connected to another machine."
        control={
          <Select
            value={settings.engine}
            onValueChange={(engine) => {
              if (engine === "native" || engine === "server" || engine === "off")
                update({ engine });
            }}
          >
            <SelectTrigger size="sm" aria-label="Transcription engine">
              <SelectValue>
                {settings.engine === "native"
                  ? "Apple (on device)"
                  : settings.engine === "server"
                    ? "Custom server"
                    : "Off"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="native" disabled={!native}>
                Apple (on device)
              </SelectItem>
              <SelectItem value="server">Custom server</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {settings.engine !== "off" ? (
        <>
          <SettingsRow
            {...searchableSetting("voice-input-send-on-enter")}
            description="Press Enter in the composer while recording to transcribe and send. Turn off to leave the text in your draft. The stop button always leaves the text for review."
            control={
              <Switch
                checked={settings.sendOnEnter}
                onCheckedChange={(checked) => update({ sendOnEnter: checked })}
                aria-label="Send dictation on Enter"
              />
            }
          />
          <SettingsRow
            title="Language"
            description="Leave blank to use the device language for Apple transcription, or automatic language detection on a custom server."
            control={
              <div className="w-56 max-w-full">
                <DraftInput
                  value={settings.language}
                  onCommit={(language) => update({ language })}
                  placeholder="Automatic"
                  aria-label="Transcription language"
                />
              </div>
            }
          />
          {settings.engine === "server" ? (
            <>
              <SettingsRow
                title="Server URL"
                description="An API base URL, such as http://localhost:8000/v1. Audio is sent directly from this client to this server."
                control={
                  <div className="w-72 max-w-full">
                    <DraftInput
                      value={settings.serverUrl}
                      onCommit={(serverUrl) => update({ serverUrl })}
                      placeholder="http://localhost:8000/v1"
                      aria-label="Transcription server URL"
                    />
                  </div>
                }
              />
              <SettingsRow
                title="Model"
                description="The speech-to-text model ID used by your server, including an MLX model ID or local model path."
                control={
                  <div className="w-72 max-w-full">
                    <DraftInput
                      value={settings.model}
                      onCommit={(model) => update({ model })}
                      placeholder="Model ID"
                      aria-label="Transcription model"
                    />
                  </div>
                }
              />
              <SettingsRow
                title="API key"
                description="Optional. Stored in this client's settings."
                control={
                  <div className="w-72 max-w-full">
                    <DraftInput
                      type="password"
                      autoComplete="off"
                      value={settings.apiKey}
                      onCommit={(apiKey) => update({ apiKey })}
                      aria-label="Transcription API key"
                    />
                  </div>
                }
              />
            </>
          ) : null}
          <SettingsRow
            title={settings.engine === "native" ? "Apple transcription" : "Server connection"}
            description={
              settings.engine === "native"
                ? "Requires a supported Mac with macOS 26 or later. Language assets download on first use; transcription runs on your Mac."
                : "Uses an OpenAI-compatible audio transcription API. Browser clients also require the server to allow their origin."
            }
            status={
              status ? (
                <span role="status" className="break-words">
                  {status}
                </span>
              ) : null
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={operation !== null || (settings.engine === "native" && !native)}
                onClick={() => {
                  void check();
                }}
              >
                {operation
                  ? "Checking…"
                  : settings.engine === "native"
                    ? "Check availability"
                    : "Test connection"}
              </Button>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
