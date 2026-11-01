import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { setupProfiles } from "../../state/setupProfiles";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { SettingsSection } from "./components/SettingsSection";

export function SetupProfileSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const state = useEnvironmentQuery(
    config?.environment.capabilities.setupProfiles === 1
      ? setupProfiles.state({ environmentId, input: {} })
      : null,
  );
  const allowed = useAtomValue(setupProfiles.command.permissionAtom(environmentId));
  const command = useAtomCommand(setupProfiles.command, { reportFailure: false });
  const enroll = useAtomCommand(setupProfiles.enroll, { reportFailure: false });
  const { environments } = useEnvironments();
  const owners = environments.filter(
    (e) =>
      e.environmentId !== environmentId &&
      e.serverConfig?.environment.capabilities.setupProfiles === 1,
  );
  const [owner, setOwner] = useState<EnvironmentId | null>(null);
  const sourceId = owner ?? owners[0]?.environmentId ?? environmentId;
  const source = useEnvironmentQuery(
    sourceId !== environmentId ? setupProfiles.state({ environmentId: sourceId, input: {} }) : null,
  );
  const canGrant = useAtomValue(setupProfiles.grant.permissionAtom(sourceId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const binding = state.data?.binding;
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    setBusy(true);
    setError(null);
    return await (async () => {
      const result = await command({ environmentId, input });
      if (isAtomCommandInterrupted(result) || result._tag === "Failure")
        setError("The setup operation failed. Check access and try again.");
    })().finally(() => {
      setBusy(false);
    });
  };
  if (config?.environment.capabilities.setupProfiles !== 1) return null;
  const url = linkableMachines({
    environments,
    threadEnvironmentId: environmentId,
    links: [],
    connect: new Map(),
  })
    .find((e) => e.environmentId === sourceId)
    ?.urls.find((url) => url.startsWith("https://"));
  return (
    <SettingsSection title="Setup profiles">
      <View className="gap-2 p-4">
        <Text className="text-base text-foreground">
          {binding?.profile.name ?? "No setup profile applied"}
        </Text>
        {binding ? (
          <Text className="text-sm text-foreground-muted">
            Applied revision {binding.appliedRevision} · {binding.enabled ? "Sync on" : "Sync off"}
          </Text>
        ) : null}
        {state.error || error || binding?.error ? (
          <Text className="text-sm text-danger-foreground">
            {error ?? state.error ?? binding?.error}
          </Text>
        ) : null}
        {binding?.items.map((item) => (
          <Text
            key={`${item.instanceId}:${item.kind}:${item.name}`}
            className="text-sm text-foreground-muted"
          >
            {item.name} · {item.status}
          </Text>
        ))}
      </View>
      {binding ? (
        <>
          <ListActionRow
            label={binding.enabled ? "Pause setup sync" : "Resume setup sync"}
            disabled={!allowed || busy}
            onPress={() => void run({ operation: "pause", paused: binding.enabled })}
          />
          <ListActionRow
            label="Retry setup"
            disabled={!allowed || busy}
            onPress={() => void run({ operation: "reconcile" })}
          />
          <ListActionRow
            label="Detach and keep setup"
            disabled={!allowed || busy}
            onPress={() => void run({ operation: "detach", removeManaged: false })}
          />
        </>
      ) : null}
      {state.data?.profiles.map((p) => (
        <ListActionRow
          key={p.id}
          label={`Apply ${p.name}`}
          description="Apply to enabled harnesses and keep synchronized"
          disabled={!allowed || busy}
          onPress={() =>
            void run({
              operation: "apply",
              profileId: p.id,
              subscribe: true,
              instanceIds: config.providers.filter((p) => p.enabled).map((p) => p.instanceId),
            })
          }
        />
      ))}
      {owners.map((e) => (
        <ListActionRow
          key={e.environmentId}
          label={`Profiles on ${e.label}`}
          onPress={() => setOwner(e.environmentId)}
        />
      ))}
      {source.data?.profiles.map((p) => (
        <ListActionRow
          key={p.id}
          label={`Subscribe to ${p.name}`}
          disabled={busy || !allowed || !canGrant || !url}
          description={
            url
              ? "Apply to enabled harnesses on this environment"
              : "A server-reachable HTTPS route to the owner is required"
          }
          onPress={async () => {
            if (!url) return;
            setBusy(true);
            setError(null);
            return await (async () => {
              const result = await enroll({
                ownerId: sourceId,
                destinationId: environmentId,
                profileId: p.id,
                sourceUrl: url,
                instanceIds: config.providers.filter((p) => p.enabled).map((p) => p.instanceId),
              });
              if (isAtomCommandInterrupted(result) || result._tag === "Failure")
                setError("Could not subscribe to this setup profile.");
            })().finally(() => {
              setBusy(false);
            });
          }}
        />
      ))}
    </SettingsSection>
  );
}
