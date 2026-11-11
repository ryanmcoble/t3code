import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import {
  AuthDiagnosticsReadScope,
  type ContainerRecord,
  type ContainerSnapshot,
  type ContainerFolderRule,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  containerPanelSummary,
  containerMetricsLabel,
  groupContainers,
  containerRuleAvailability,
  resolveContainerFolders,
  type ContainerFilter,
} from "@t3tools/client-runtime/state/shared-capabilities";
import { useState, useSyncExternalStore } from "react";
import { AppState, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useProjects } from "../../state/entities";
import { type EnvironmentQueryView, useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

function subscribeActivity(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}
const isActive = () => AppState.currentState === "active";

export function ContainerSection({
  environmentId,
  folders,
}: {
  readonly environmentId: EnvironmentId;
  readonly folders?: ReadonlyArray<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cachedSummary, setCachedSummary] = useState("View this environment’s Docker containers");
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeActivity, isActive, isActive);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const supported = config?.environment.capabilities.containers === 1;
  const snapshot = useEnvironmentQuery(
    expanded && focused && active && canRead && supported
      ? sharedCapabilities.containers({ environmentId, input: {} })
      : null,
  );
  return (
    <SettingsSection title="Containers">
      <ListActionRow
        label={expanded ? "Close containers" : "View containers"}
        description={snapshot.data ? containerPanelSummary(snapshot.data, folders) : cachedSummary}
        onPress={() => {
          if (expanded && snapshot.data)
            setCachedSummary(containerPanelSummary(snapshot.data, folders));
          setExpanded(!expanded);
        }}
      />
      {expanded ? (
        !supported ? (
          <View className="p-4">
            <Text>
              {config
                ? "Update this environment to view Docker containers."
                : "Waiting for this environment…"}
            </Text>
          </View>
        ) : !canRead ? (
          <View className="p-4">
            <Text>This connection needs diagnostics read access.</Text>
          </View>
        ) : (
          <ContainerList
            environmentId={environmentId}
            snapshot={snapshot}
            {...(folders ? { folders } : {})}
          />
        )
      ) : null}
    </SettingsSection>
  );
}

function ContainerList({
  environmentId,
  folders,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly folders?: ReadonlyArray<string>;
  readonly snapshot: EnvironmentQueryView<ContainerSnapshot>;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(40);
  const data = snapshot.data;
  const resolvedFolders = folders
    ? resolveContainerFolders(folders, data?.folderAliases ?? [])
    : undefined;
  const groups = groupContainers(data?.containers ?? [], {
    search,
    filter,
    ...(resolvedFolders ? { folders: resolvedFolders } : {}),
  });
  const visibleIds = groups
    .flatMap((group) => group.containers)
    .slice(0, limit)
    .map((container) => container.id);
  return (
    <View>
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground-muted">
          {snapshot.error ?? data?.message ?? "Checking Docker…"}
        </Text>
        {data?.stale && data.status !== "starting" ? (
          <Text className="text-sm text-foreground-muted">
            Cached sample; current engine state is unavailable.
          </Text>
        ) : null}
        {data && data.status !== "starting" && !data.complete ? (
          <Text className="text-sm text-foreground-muted">Partial inventory</Text>
        ) : null}
        <TextInput
          accessibilityLabel="Search containers"
          placeholder="Search containers"
          value={search}
          onChangeText={(value) => {
            setSearch(value);
            setLimit(40);
          }}
          className="rounded-lg border border-border p-3 text-foreground"
        />
      </View>
      <ListActionRow label="Refresh inventory" onPress={snapshot.refresh} />
      <ListActionRow
        label={`Filter: ${filter === "all" ? "All states" : filter}`}
        onPress={() => setShowFilters(!showFilters)}
      />
      {showFilters
        ? (["all", "running", "stopped", "unhealthy"] as const).map((value) => (
            <ListChoiceRow
              key={value}
              label={value === "all" ? "All states" : value}
              selected={filter === value}
              onPress={() => {
                setFilter(value);
                setLimit(40);
                setShowFilters(false);
              }}
            />
          ))
        : null}
      {groups.map((group) => (
        <View key={group.key}>
          <View className="px-4 py-2">
            <Text className="text-sm font-t3-medium text-foreground-muted">
              {group.label} · {group.containers.length}
            </Text>
          </View>
          {group.containers
            .filter((container) => visibleIds.includes(container.id))
            .map((container) => (
              <NativeContainerRow
                key={container.id}
                environmentId={environmentId}
                engineId={data!.engineId!}
                container={container}
              />
            ))}
        </View>
      ))}
      {groups.flatMap((group) => group.containers).length > limit ? (
        <ListActionRow label="Show more containers" onPress={() => setLimit(limit + 40)} />
      ) : null}
      {data ? (
        <NativeContainerRules
          environmentId={environmentId}
          snapshot={data}
          {...(resolvedFolders ? { folders: resolvedFolders } : {})}
        />
      ) : null}
      {data && data.status !== "starting" && !groups.length ? (
        <View className="p-4">
          <Text className="text-sm text-foreground-muted">
            {folders
              ? "No containers linked to these folders. Link one in the environment’s container overview."
              : data.containers.length
                ? "No containers match this filter."
                : data.status === "ready"
                  ? "No containers on this Docker engine."
                  : "Inventory is unavailable."}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function NativeContainerRules({
  environmentId,
  snapshot,
  folders,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: ContainerSnapshot;
  readonly folders?: ReadonlyArray<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useAtomValue(sharedCapabilities.containerAssociate.permissionAtom(environmentId));
  const associate = useAtomCommand(sharedCapabilities.containerAssociate, { reportFailure: false });
  const rules = (snapshot.associationRules ?? []).filter(
    (rule) => !folders || folders.includes(rule.folder),
  );
  const remove = async (rule: ContainerFolderRule) => {
    const result = await associate({
      environmentId,
      input: {
        engineId: rule.engineId,
        containerId: rule.containerId,
        folder: rule.folder,
        ruleId: rule.id,
        operation: "remove",
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The saved rule could not be removed.");
    } else setError(null);
  };
  if (!rules.length) return null;
  return (
    <View>
      <ListActionRow
        label={`Saved folder links and exclusions · ${rules.length}`}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded
        ? rules.map((rule) => (
            <ListActionRow
              key={`${rule.engineId}:${rule.id}:${rule.folder}`}
              label={`${rule.rule === "exclude" ? "Remove exclusion" : "Unlink"}: ${rule.label}`}
              description={`${rule.stackKey ? "Compose stack" : "Container"} · ${rule.folder} · ${containerRuleAvailability(snapshot, rule)}`}
              disabled={!allowed}
              onPress={() => void remove(rule)}
            />
          ))
        : null}
      {error ? (
        <View className="p-4">
          <Text className="text-sm text-danger-foreground">{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

function NativeContainerRow({
  environmentId,
  engineId,
  container,
}: {
  readonly environmentId: EnvironmentId;
  readonly engineId: string;
  readonly container: ContainerRecord;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <ListActionRow
        label={`${container.name} · ${container.state}${container.health ? ` · ${container.state === "running" ? "" : "last health: "}${container.health}` : ""}`}
        description={containerMetricsLabel(container)}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <NativeContainerInspector
          environmentId={environmentId}
          engineId={engineId}
          container={container}
        />
      ) : null}
    </View>
  );
}

function NativeContainerInspector({
  environmentId,
  engineId,
  container,
}: {
  readonly environmentId: EnvironmentId;
  readonly engineId: string;
  readonly container: ContainerRecord;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [chooseFolder, setChooseFolder] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [scope, setScope] = useState<"container" | "stack">("container");
  const [showLogs, setShowLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAssociate = useAtomValue(
    sharedCapabilities.containerAssociate.permissionAtom(environmentId),
  );
  const associate = useAtomCommand(sharedCapabilities.containerAssociate, { reportFailure: false });
  const logs = useEnvironmentQuery(
    showLogs
      ? sharedCapabilities.containerLogs({
          environmentId,
          input: { engineId, containerId: container.id, lines: 200 },
        })
      : null,
  );
  const change = async (
    operation: "include" | "exclude" | "remove",
    target: string,
    ruleId?: string,
    targetScope: "container" | "stack" = "container",
  ) => {
    const result = await associate({
      environmentId,
      input: {
        engineId,
        containerId: container.id,
        folder: target,
        operation,
        scope: targetScope,
        ...(ruleId ? { ruleId } : {}),
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "The folder link could not be changed. Check access and refresh.",
      );
    } else setError(null);
  };
  return (
    <View>
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground">Image: {container.image || "Unavailable"}</Text>
        <Text selectable className="text-xs text-foreground-muted">
          {container.id}
        </Text>
        <Text className="text-sm text-foreground">
          Compose:{" "}
          {[container.composeProject, container.composeService].filter(Boolean).join(" / ") ||
            "Not a Compose service"}
        </Text>
        <Text className="text-sm text-foreground">Restarts: {container.restartCount}</Text>
        <Text className="text-sm text-foreground">
          Ports on this environment:{" "}
          {container.ports
            .map(
              (port) => `${port.hostIp}:${port.hostPort} → ${port.containerPort}/${port.protocol}`,
            )
            .join(", ") || "None"}
        </Text>
        <Text className="text-xs text-foreground-muted">
          Folder links describe related work. They do not grant thread ownership or cleanup
          permission.
        </Text>
        {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
      </View>
      {container.associations.map((link) => (
        <ListActionRow
          key={link.folder}
          label={`${link.source === "manual" ? (link.scope === "stack" ? "Unlink stack" : "Unlink") : "Exclude match"}: ${link.folder}`}
          description={link.source === "mount" ? "Related via mount" : link.source}
          disabled={!canAssociate}
          onPress={() =>
            void change(link.source === "manual" ? "remove" : "exclude", link.folder, link.ruleId)
          }
        />
      ))}
      <ListChoiceRow
        label="Link this container"
        selected={scope === "container"}
        onPress={() => setScope("container")}
      />
      <ListChoiceRow
        label="Link the Compose stack"
        description="Keep the link when its containers are recreated"
        selected={scope === "stack"}
        disabled={!container.stackKey}
        onPress={() => setScope("stack")}
      />
      <ListActionRow
        label="Choose project folder"
        description={folder ?? "Select where this container belongs"}
        disabled={!canAssociate}
        onPress={() => setChooseFolder(!chooseFolder)}
      />
      {chooseFolder
        ? projects.map((project) => (
            <ListChoiceRow
              key={project.id}
              label={project.title}
              description={project.workspaceRoot}
              selected={folder === project.workspaceRoot}
              onPress={() => {
                setFolder(project.workspaceRoot);
                setChooseFolder(false);
              }}
            />
          ))
        : null}
      <ListActionRow
        label="Link folder"
        disabled={!canAssociate || !folder}
        onPress={() => {
          if (folder) void change("include", folder, undefined, scope);
        }}
      />
      <ListActionRow
        label={showLogs ? "Close logs" : "Read recent logs"}
        onPress={() => setShowLogs(!showLogs)}
      />
      {showLogs ? (
        <View>
          <ListActionRow label="Refresh logs" onPress={logs.refresh} />
          <View className="px-4">
            <Text className="text-sm text-foreground-muted">
              {logs.error ??
                (logs.data?.truncated ? "Log output was truncated." : "Most recent 200 lines")}
            </Text>
          </View>
          <ScrollView className="max-h-64 p-4">
            <Text selectable className="font-mono text-xs text-foreground">
              {logs.data?.text ?? "Loading recent logs…"}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
