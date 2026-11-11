import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { SettingsRow, SettingsSection, useSettingsSearchTargetId } from "./settingsLayout";
import { SetupProfilesSettings } from "./SetupProfilesSettings";
import { SharedMemorySettings } from "./SharedMemorySettings";
import { ComputerUseSettings } from "./ComputerUseSettings";

type SetupArea = "tools" | "memory" | "computer";

export function EnvironmentSetupSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const [area, setArea] = useState<SetupArea>("tools");
  const targetId = useSettingsSearchTargetId();
  const [openedForTarget, setOpenedForTarget] = useState<string | null>(null);
  const requestedArea =
    targetId === "computer-use"
      ? "computer"
      : targetId === "shared-memory"
        ? "memory"
        : targetId === "setup-mcp-skills"
          ? "tools"
          : null;
  if (requestedArea !== null && openedForTarget !== targetId) {
    setOpenedForTarget(targetId);
    setArea(requestedArea);
  }
  const environment =
    environments.find((item) => item.environmentId === selectedId) ?? environments[0];
  if (!environment) return null;
  return (
    <>
      <SettingsSection title="Environment setup">
        <SettingsRow
          title="Manage setup on"
          description="Changes below apply only to the selected environment."
          control={
            <Select
              value={environment.environmentId}
              onValueChange={(value) => {
                const selected = environments.find((item) => item.environmentId === value);
                if (selected) setSelectedId(selected.environmentId);
              }}
            >
              <SelectTrigger aria-label="Setup environment">
                <SelectValue>{environment.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((item) => (
                  <SelectItem key={item.environmentId} value={item.environmentId}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Setup area"
          control={
            <ToggleGroup
              value={[area]}
              onValueChange={(values) => {
                const value = values[0];
                if (value === "tools" || value === "memory" || value === "computer") setArea(value);
              }}
              aria-label="Environment setup area"
            >
              <ToggleGroupItem value="tools">MCP & skills</ToggleGroupItem>
              <ToggleGroupItem value="memory">Memory</ToggleGroupItem>
              <ToggleGroupItem value="computer">Computer use</ToggleGroupItem>
            </ToggleGroup>
          }
        />
      </SettingsSection>
      {area === "tools" ? (
        <SetupProfilesSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ) : null}
      {area === "memory" ? (
        <SharedMemorySettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ) : null}
      {area === "computer" ? (
        <ComputerUseSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ) : null}
    </>
  );
}
