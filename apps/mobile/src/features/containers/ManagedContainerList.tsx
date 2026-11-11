import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ContainerSnapshot,
  EnvironmentId,
  ManagedContainer,
  ManagedContainerCommand,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useAtomCommand } from "../../state/use-atom-command";

export function ManagedContainerList({
  environmentId,
  threadId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly snapshot?: ContainerSnapshot;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.managedContainers === 1;
  const query = useEnvironmentQuery(
    supported
      ? sharedCapabilities.managedContainers({ environmentId, input: threadId ? { threadId } : {} })
      : null,
  );
  const [limit, setLimit] = useState(20);
  if (!supported) return null;
  return (
    <View>
      <ListActionRow
        label="Managed resources"
        description="Only containers with a durable T3 ownership receipt have lifecycle controls. Folder links do not grant ownership."
        onPress={query.refresh}
      />
      {query.error ? (
        <View className="p-4">
          <Text>{query.error}</Text>
        </View>
      ) : null}
      {query.data && !query.data.complete ? (
        <View className="p-4">
          <Text>Partial history: latest 1,000 resource receipts.</Text>
        </View>
      ) : null}
      {query.data?.items.slice(0, limit).map((resource) => (
        <ManagedContainerRow
          key={resource.resourceId}
          environmentId={environmentId}
          resource={resource}
          actorId={threadId ?? resource.threadId}
          state={
            snapshot?.engineId === resource.engineId && !snapshot.stale
              ? snapshot.containers.find((container) => container.id === resource.containerId)
                  ?.state
              : undefined
          }
          onRefresh={query.refresh}
        />
      ))}
      {query.data?.items.length === 0 ? (
        <View className="p-4">
          <Text className="text-sm text-foreground-muted">
            No T3-managed containers. Existing Docker containers remain visible above.
          </Text>
        </View>
      ) : null}
      {(query.data?.items.length ?? 0) > limit ? (
        <ListActionRow label="Show more receipts" onPress={() => setLimit(limit + 20)} />
      ) : null}
    </View>
  );
}

function ManagedContainerRow({
  environmentId,
  resource,
  actorId,
  state,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly resource: ManagedContainer;
  readonly actorId: ThreadId;
  readonly state: string | undefined;
  readonly onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useAtomCommand(sharedCapabilities.managedContainerCommand, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    sharedCapabilities.managedContainerCommand.permissionAtom(environmentId),
  );
  const shared = resource.references.length > 1;
  const disabled = busy || !permitted || !resource.references.includes(actorId);
  const run = async (operation: (typeof ManagedContainerCommand.Type)["operation"]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: {
          resourceId: resource.resourceId,
          threadId: actorId,
          generation: resource.generation,
          operation,
        },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    } catch {
      setError("Could not complete this action. Refresh ownership and try again.");
    }
    setBusy(false);
    onRefresh();
  };
  const release = () =>
    Alert.alert(
      shared ? "Detach reference?" : "Release container?",
      shared
        ? "The shared container keeps running."
        : "T3 will stop and remove only this disposable container. Mounted workspace files remain on disk.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: shared ? "Detach" : "Release",
          style: "destructive",
          onPress: () => void run("release"),
        },
      ],
    );
  return (
    <View>
      <ListActionRow
        label={resource.name}
        description={`${resource.phase}${state ? ` · ${state}` : ""}${resource.retained ? " · Retained" : ""}${shared ? ` · ${resource.references.length} references` : ""}`}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <View>
          <View className="px-4 py-2">
            <Text className="text-xs text-foreground-muted">
              {resource.containerId?.slice(0, 12) ?? "Creation pending"}
            </Text>
            {resource.failure ? (
              <Text>
                Last action failed: {resource.failure}. Refresh inventory and ownership before
                retrying.
              </Text>
            ) : null}
            {error ? <Text>{error}</Text> : null}
          </View>
          {resource.phase !== "released" ? (
            <>
              {resource.phase === "ready" && !shared && state ? (
                <ListActionRow
                  label={state === "running" ? "Stop" : "Start"}
                  disabled={disabled}
                  onPress={() => void run(state === "running" ? "stop" : "start")}
                />
              ) : null}
              {resource.phase === "pending" || resource.phase === "failed" ? (
                <ListActionRow
                  label="Recover creation"
                  disabled={disabled}
                  onPress={() => void run("retry")}
                />
              ) : null}
              {actorId === resource.threadId ? (
                <ListActionRow
                  label={resource.retained ? "Clear retention" : "Retain"}
                  disabled={disabled}
                  onPress={() => void run(resource.retained ? "unretain" : "retain")}
                />
              ) : null}
              <ListActionRow
                label={
                  shared
                    ? "Detach reference"
                    : resource.phase === "releasing"
                      ? "Retry release"
                      : "Release container"
                }
                disabled={
                  disabled ||
                  resource.retained ||
                  (shared && actorId === resource.threadId) ||
                  resource.containerId === null
                }
                onPress={release}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
