import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { sharedProjectMemberLabel } from "@t3tools/client-runtime/state/shared-capabilities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SharedProjectManifest } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useAtomCommand } from "../../state/use-atom-command";

export function SharedProjectEnrollmentSection({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<SharedProjectManifest>;
}) {
  const { environments } = useEnvironments();
  const owners = environments.filter(
    (machine) =>
      machine.environmentId !== environmentId &&
      machine.serverConfig?.environment.capabilities.sharedProjectEnrollment === 1,
  );
  const [selectedOwner, setSelectedOwner] = useState<EnvironmentId | null>(null);
  const ownerId =
    owners.find((machine) => machine.environmentId === selectedOwner)?.environmentId ??
    owners[0]?.environmentId ??
    environmentId;
  const source = useEnvironmentQuery(
    ownerId !== environmentId
      ? sharedCapabilities.sharedProjectState({ environmentId: ownerId, input: {} })
      : null,
  );
  const subscriptions = useEnvironmentQuery(
    sharedCapabilities.sharedProjectEnrollmentState({ environmentId, input: {} }),
  );
  const available =
    source.data?.projects.filter(
      (project) =>
        project.ownerEnvironmentId === ownerId &&
        !project.archived &&
        project.members.includes(environmentId),
    ) ?? [];
  const [selectedProject, setSelectedProject] = useState("");
  const projectId =
    available.find((project) => project.id === selectedProject)?.id ?? available[0]?.id ?? "";
  const canGrant = useAtomValue(sharedCapabilities.sharedProjectGrant.permissionAtom(ownerId));
  const canConfigure = useAtomValue(
    sharedCapabilities.sharedProjectEnrollmentCommand.permissionAtom(environmentId),
  );
  const enroll = useAtomCommand(sharedCapabilities.enrollSharedProject, { reportFailure: false });
  const command = useAtomCommand(sharedCapabilities.sharedProjectEnrollmentCommand, {
    reportFailure: false,
  });
  const machine = linkableMachines({
    environments,
    threadEnvironmentId: environmentId,
    links: [],
    connect: new Map(),
  }).find((machine) => machine.environmentId === ownerId);
  const sourceUrl = machine?.urls.find((url) => url.startsWith("https://"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = async (input: Parameters<typeof command>[0]["input"] | null) => {
    if (inFlight.current || (!input && (!sourceUrl || !projectId))) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (input) result = await command({ environmentId, input });
      else
        result = await enroll({
          ownerId,
          destinationId: environmentId,
          sharedProjectId: projectId,
          sourceUrl: sourceUrl!,
        });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    } catch {
      setError("Could not update the subscription. Refresh and retry on both machines.");
    }
    inFlight.current = false;
    setBusy(false);
  };
  const disconnect = (id: string) =>
    Alert.alert(
      "Disconnect project owner?",
      "Local mappings will detach. Project folders and files stay on disk. The owner can revoke its grant separately.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => void run({ operation: "disconnect", sharedProjectId: id }),
        },
      ],
    );
  return (
    <View>
      <View className="p-4">
        <Text className="text-sm">Follow a project owner</Text>
        <Text className="text-xs text-foreground-muted">
          Follow project definitions in the background, then choose local folders. Enrollment does
          not transfer project content or account sign-ins.
        </Text>
      </View>
      {owners.map((owner) => (
        <ListChoiceRow
          key={owner.environmentId}
          label={owner.label}
          description="Project owner"
          selected={owner.environmentId === ownerId}
          disabled={busy}
          onPress={() => {
            setSelectedOwner(owner.environmentId);
            setSelectedProject("");
          }}
        />
      ))}
      {!owners.length ? (
        <View className="p-4">
          <Text>
            Connect another environment with shared project enrollment to follow its projects.
          </Text>
        </View>
      ) : (
        <>
          {available.map((project) => (
            <ListChoiceRow
              key={project.id}
              label={project.name}
              selected={project.id === projectId}
              disabled={busy}
              onPress={() => setSelectedProject(project.id)}
            />
          ))}
          {!available.length ? (
            <View className="p-4">
              <Text>Select this machine as a project member on the owner first.</Text>
            </View>
          ) : null}
          {!sourceUrl ? (
            <View className="p-4">
              <Text>Add an HTTPS route that this machine can use to reach the owner.</Text>
            </View>
          ) : null}
          <ListActionRow
            label="Enroll this machine"
            disabled={busy || !canGrant || !canConfigure || !sourceUrl || !projectId}
            onPress={() => void run(null)}
          />
        </>
      )}
      {error || source.error || subscriptions.error ? (
        <View className="p-4">
          <Text>{error ?? source.error ?? subscriptions.error}</Text>
        </View>
      ) : null}
      {!subscriptions.data ? (
        <View className="p-4">
          <Text>Loading subscriptions…</Text>
        </View>
      ) : null}
      {subscriptions.data?.subscriptions.map((subscription) => (
        <View key={subscription.sharedProjectId}>
          <View className="p-4">
            <Text>
              {projects.find((project) => project.id === subscription.sharedProjectId)?.name ??
                "Shared project"}{" "}
              · {sharedProjectMemberLabel(subscription.ownerEnvironmentId, environments)}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {subscription.paused
                ? "Paused"
                : (subscription.error ??
                  `Following project revision ${subscription.observedRevision}`)}
            </Text>
          </View>
          <ListActionRow
            label="Refresh owner"
            disabled={busy || !canConfigure}
            onPress={() =>
              void run({ operation: "refresh", sharedProjectId: subscription.sharedProjectId })
            }
          />
          <ListActionRow
            label={subscription.paused ? "Resume" : "Pause"}
            disabled={busy || !canConfigure}
            onPress={() =>
              void run({
                operation: "pause",
                sharedProjectId: subscription.sharedProjectId,
                paused: !subscription.paused,
              })
            }
          />
          <ListActionRow
            label="Disconnect"
            disabled={busy || !canConfigure}
            onPress={() => disconnect(subscription.sharedProjectId)}
          />
        </View>
      ))}
    </View>
  );
}
