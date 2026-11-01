import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function ComputerUseSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(sharedCapabilities.computerCommand.permissionAtom(environmentId));
  const supported = config?.environment.capabilities.computerUse === 1;
  const state = useEnvironmentQuery(
    supported && allowed ? sharedCapabilities.computerState({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(sharedCapabilities.computerCommand, { reportFailure: false });
  const value = state.data?.config;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [apps, setApps] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [providers, setProviders] = useState<ReadonlyArray<ProviderInstanceId> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = providers ?? value?.providerInstanceIds ?? [];
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    const result = await command({ environmentId, input });
    if (isAtomCommandInterrupted(result) || result._tag === "Failure")
      setError("Desktop settings could not be changed.");
    else {
      setError(null);
      state.refresh();
    }
  };
  if (!supported) return null;
  return (
    <SettingsSection title="Computer use">
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground-muted">
          Control allowed apps on this environment. One thread holds the desktop lease; you can
          release it here.
        </Text>
        <Text className="text-sm text-foreground">
          {state.data?.readiness} · {state.data?.message}
        </Text>
        {error || state.error ? (
          <Text className="text-sm text-danger-foreground">{error ?? state.error}</Text>
        ) : null}
        <Text className="text-sm text-foreground">
          {state.data?.lease
            ? `Controlled by ${state.data.lease.label} · ${state.data.lease.bundleId}`
            : "No desktop lease"}
        </Text>
      </View>
      {state.data?.lease ? (
        <ListActionRow
          label="Release desktop"
          tone="danger"
          disabled={!allowed}
          onPress={() => void run({ operation: "release" })}
        />
      ) : null}
      <ListToggleRow
        label="Enable computer use"
        value={enabled ?? value?.enabled ?? false}
        disabled={!allowed}
        onValueChange={setEnabled}
      />
      <View className="gap-2 p-4">
        <TextInput
          accessibilityLabel="Allowed desktop apps"
          placeholder="Allowed app bundle IDs, comma-separated"
          value={apps ?? value?.allowedApps.join(", ") ?? ""}
          onChangeText={setApps}
          className="rounded-lg border border-border p-3 text-foreground"
        />
        <TextInput
          accessibilityLabel="Cua Driver executable"
          value={path ?? value?.command ?? "cua-driver"}
          onChangeText={setPath}
          className="rounded-lg border border-border p-3 text-foreground"
        />
      </View>
      {config?.providers.map((p) => (
        <ListToggleRow
          key={p.instanceId}
          label={p.displayName ?? p.instanceId}
          value={ids.includes(p.instanceId)}
          disabled={!allowed}
          onValueChange={(on) =>
            setProviders(on ? [...ids, p.instanceId] : ids.filter((id) => id !== p.instanceId))
          }
        />
      ))}
      <ListActionRow
        label="Save desktop access"
        disabled={!allowed}
        onPress={() =>
          void run({
            operation: "configure",
            config: {
              enabled: enabled ?? value?.enabled ?? false,
              command: path ?? value?.command ?? "cua-driver",
              allowedApps: (apps ?? value?.allowedApps.join(",") ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              providerInstanceIds: ids,
            },
          })
        }
      />
      <ListActionRow
        label="Use profile desktop policy"
        disabled={!allowed}
        onPress={() => void run({ operation: "inherit" })}
      />
      <ListActionRow label="Check permissions" onPress={() => state.refresh()} />
      <ListActionRow
        label="Cua Driver installation and OS permissions"
        onPress={() => void Linking.openURL("https://cua.ai/docs/cua-driver/quickstart")}
      />
    </SettingsSection>
  );
}
