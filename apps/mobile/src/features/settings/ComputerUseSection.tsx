import { ComputerAppAccessPicker } from "./ComputerAppAccessPicker";
import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Linking, TextInput, View } from "react-native";
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
  const [apps, setApps] = useState<ReadonlyArray<string> | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [providers, setProviders] = useState<ReadonlyArray<ProviderInstanceId> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = providers ?? value?.providerInstanceIds ?? [];
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    const result = await command({ environmentId, input });
    if (isAtomCommandInterrupted(result) || result._tag === "Failure") {
      setError("Desktop settings could not be changed. Check access and setup, then try again.");
      return false;
    }
    setError(null);
    setEnabled(null);
    setApps(null);
    setPath(null);
    setProviders(null);
    state.refresh();
    return true;
  };
  if (!supported) return null;
  const checks = state.data?.checks;
  const enabledProviders = config.providers.filter((provider) => provider.enabled);
  const selectedApps = apps ?? value?.allowedApps ?? [];
  const save = () => {
    const apply = () =>
      void run({
        operation: "configure",
        config: {
          enabled: enabled ?? value?.enabled ?? false,
          command: path ?? value?.command ?? "cua-driver",
          allowedApps: selectedApps,
          ...(config.environment.capabilities.computerUseAppRules === 1
            ? { appRulesVersion: 1 as const }
            : {}),
          providerInstanceIds: ids,
        },
      });
    const broadRules = selectedApps.filter(
      (rule) =>
        rule.includes("*") && (value?.appRulesVersion !== 1 || !value.allowedApps.includes(rule)),
    );
    if ((enabled ?? value?.enabled ?? false) && broadRules.length)
      Alert.alert(
        "Expand desktop access?",
        `The selected harnesses will be able to observe and control every application matching: ${broadRules.join(", ")}.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Allow matching applications", onPress: apply },
        ],
      );
    else apply();
  };
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
        {checks ? (
          <>
            <Text className="text-sm text-foreground-muted">
              Driver:{" "}
              {checks.driver === "available"
                ? "Available"
                : "Check installation on this environment"}
            </Text>
            <Text className="text-sm text-foreground-muted">
              Accessibility:{" "}
              {checks.accessibility === true
                ? "Allowed"
                : checks.accessibility === false
                  ? "Needs approval on this Mac"
                  : "Not checked"}
            </Text>
            <Text className="text-sm text-foreground-muted">
              Screen Recording:{" "}
              {checks.screenRecording === true
                ? "Allowed"
                : checks.screenRecording === false
                  ? "Needs approval on this Mac"
                  : "Not checked"}
            </Text>
            <Text className="text-sm text-foreground-muted">
              An agent must observe an allowed app to verify capture.
            </Text>
          </>
        ) : null}
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
      {!value?.enabled && !ids.length && !apps && !value?.allowedApps.length ? (
        <ListActionRow
          label="Set up with Calculator"
          description={`Allow enabled harnesses: ${enabledProviders.map((provider) => provider.displayName ?? provider.driver).join(", ")}`}
          disabled={!allowed || !enabledProviders.length}
          onPress={() =>
            Alert.alert(
              "Enable computer use?",
              "Allow the enabled harnesses to control Calculator on this environment. macOS permissions stay on that Mac.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Enable for Calculator",
                  onPress: () => {
                    void run({
                      operation: "configure",
                      config: {
                        enabled: true,
                        command: value?.command ?? "cua-driver",
                        providerInstanceIds: enabledProviders.map(
                          (provider) => provider.instanceId,
                        ),
                        allowedApps: ["com.apple.calculator"],
                      },
                    });
                  },
                },
              ],
            )
          }
        />
      ) : null}
      <ListActionRow
        label="Check setup again"
        description="Recheck the driver and macOS permissions without changing access."
        onPress={state.refresh}
      />
      <ListToggleRow
        label="Enable computer use"
        value={enabled ?? value?.enabled ?? false}
        disabled={!allowed}
        onValueChange={setEnabled}
      />
      <ComputerAppAccessPicker
        rules={selectedApps}
        supportsRules={config?.environment.capabilities.computerUseAppRules === 1}
        applications={state.data?.availableApps ?? []}
        disabled={!allowed}
        onChange={setApps}
      />
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground">Cua Driver executable</Text>
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
        disabled={
          !allowed ||
          ((enabled ?? value?.enabled ?? false) && (!ids.length || !selectedApps.length))
        }
        onPress={save}
      />
      <ListActionRow
        label="Use profile desktop policy"
        disabled={!allowed}
        onPress={() => void run({ operation: "inherit" })}
      />
      <ListActionRow
        label="Cua Driver installation and OS permissions"
        onPress={() => void Linking.openURL("https://cua.ai/docs/cua-driver/quickstart")}
      />
    </SettingsSection>
  );
}
