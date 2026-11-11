import { useAtomValue } from "@effect/atom-react";
import {
  sharedProjectMappingStatus,
  sharedProjectMemberLabel,
} from "@t3tools/client-runtime/state/shared-capabilities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type SharedProjectBinding,
  type SharedProjectManifest,
} from "@t3tools/contracts";
import * as Crypto from "expo-crypto";
import { useRef, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function SharedProjectsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.sharedProjects === 1;
  const state = useEnvironmentQuery(
    supported ? sharedCapabilities.sharedProjectState({ environmentId, input: {} }) : null,
  );
  const allowed = useAtomValue(
    sharedCapabilities.sharedProjectPublish.permissionAtom(environmentId),
  );
  const [creating, setCreating] = useState(false);
  if (!supported) return null;
  return (
    <SettingsSection title="Shared projects">
      <View className="p-4">
        <Text className="text-sm text-foreground-muted">
          Choose member machines and map shared roots to local projects. Mappings preserve existing
          files; synchronization and execution readiness require separate verification.
        </Text>
      </View>
      <ListActionRow label="Refresh projects" onPress={state.refresh} />
      {state.error ? (
        <View className="p-4">
          <Text>{state.error}</Text>
        </View>
      ) : !state.data ? (
        <View className="p-4">
          <Text>Loading shared projects…</Text>
        </View>
      ) : null}
      {state.data && !state.data.complete ? (
        <View className="p-4">
          <Text>Partial project list: first 200 shared projects and mappings.</Text>
        </View>
      ) : null}
      {state.data?.projects.map((project) => (
        <SharedProjectRow
          key={project.id}
          environmentId={environmentId}
          project={project}
          binding={state.data?.bindings.find((binding) => binding.sharedProjectId === project.id)}
        />
      ))}
      {state.data?.projects.length === 0 ? (
        <View className="p-4">
          <Text>No shared projects. Start with registered project folders on this machine.</Text>
        </View>
      ) : null}
      {creating ? (
        <CreateSharedProject environmentId={environmentId} onClose={() => setCreating(false)} />
      ) : (
        <ListActionRow
          label="Create shared project"
          disabled={!allowed || !state.data?.complete}
          onPress={() => setCreating(true)}
        />
      )}
    </SettingsSection>
  );
}

function CreateSharedProject({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const { environments } = useEnvironments();
  const [id] = useState(() => Crypto.randomUUID());
  const [name, setName] = useState("");
  const [members, setMembers] = useState<ReadonlyArray<EnvironmentId>>([environmentId]);
  const [roots, setRoots] = useState<
    ReadonlyArray<{ readonly projectId: ProjectId; readonly kind: "git" | "files" }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const publish = useAtomCommand(sharedCapabilities.sharedProjectPublish, { reportFailure: false });
  const save = async () => {
    if (inFlight.current || !name.trim() || roots.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await publish({
        environmentId,
        input: {
          id,
          expectedRevision: 0,
          name: name.trim(),
          members,
          setupProfileId: null,
          archived: false,
          roots: roots.map((root, index) => ({
            id: `root-${index + 1}`,
            name: (
              projects.find((project) => project.id === root.projectId)?.title ?? "Project folder"
            ).slice(0, 128),
            kind: root.kind,
            contentPolicy: { mode: "project-content", excludePaths: [] },
          })),
        },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else onClose();
    } catch {
      setError("Could not save the project. Refresh projects before retrying.");
    }
    inFlight.current = false;
    setBusy(false);
  };
  return (
    <View>
      <TextInput
        accessibilityLabel="Shared project name"
        placeholder="Project name"
        value={name}
        maxLength={128}
        editable={!busy}
        onChangeText={setName}
        className="m-4 rounded-lg border border-border p-3 text-foreground"
      />
      {environments.map((machine) => (
        <ListToggleRow
          key={machine.environmentId}
          label={machine.label}
          description={machine.environmentId === environmentId ? "Owner machine" : "Member machine"}
          value={members.includes(machine.environmentId)}
          disabled={busy || machine.environmentId === environmentId}
          onValueChange={(selected) =>
            setMembers(
              selected
                ? [...members, machine.environmentId]
                : members.filter((id) => id !== machine.environmentId),
            )
          }
        />
      ))}
      {projects.length === 0 ? (
        <View className="p-4">
          <Text>Add a local project before creating a shared project.</Text>
        </View>
      ) : (
        projects.map((project) => {
          const root = roots.find((root) => root.projectId === project.id);
          return (
            <View key={project.id}>
              <ListToggleRow
                label={project.title}
                description={project.workspaceRoot}
                value={!!root}
                disabled={busy || (!root && roots.length >= 16)}
                onValueChange={(selected) =>
                  setRoots(
                    selected
                      ? [
                          ...roots,
                          {
                            projectId: project.id,
                            kind: project.repositoryIdentity ? "git" : "files",
                          },
                        ]
                      : roots.filter((root) => root.projectId !== project.id),
                  )
                }
              />
              {root ? (
                <ListToggleRow
                  label="Git repository"
                  value={root.kind === "git"}
                  disabled={busy}
                  onValueChange={(git) =>
                    setRoots(
                      roots.map((item) =>
                        item.projectId === project.id
                          ? { ...item, kind: git ? "git" : "files" }
                          : item,
                      ),
                    )
                  }
                />
              ) : null}
            </View>
          );
        })
      )}
      <View className="p-4">
        <Text className="text-xs text-foreground-muted">
          Credentials, native application state, dependencies and generated outputs stay excluded.
          Review local mappings after creating the project.
        </Text>
        {error ? <Text>{error}</Text> : null}
      </View>
      <ListActionRow
        label={busy ? "Creating…" : "Create shared project"}
        disabled={busy || !name.trim() || roots.length === 0}
        onPress={() => void save()}
      />
      <ListActionRow label="Cancel" disabled={busy} onPress={onClose} />
    </View>
  );
}

function SharedProjectRow({
  environmentId,
  project,
  binding,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: SharedProjectManifest;
  readonly binding: SharedProjectBinding | undefined;
}) {
  const { environments } = useEnvironments();
  const [expanded, setExpanded] = useState(false);
  const status = sharedProjectMappingStatus(project, binding, environmentId);
  return (
    <View>
      <ListActionRow
        label={project.name}
        description={`${status.title}. Owner: ${sharedProjectMemberLabel(project.ownerEnvironmentId, environments)}. Revision ${project.revision}.`}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <ProjectMappings
          key={`${project.revision}:${binding?.revision ?? 0}`}
          environmentId={environmentId}
          project={project}
          binding={binding}
        />
      ) : null}
    </View>
  );
}

function ProjectMappings({
  environmentId,
  project,
  binding,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: SharedProjectManifest;
  readonly binding: SharedProjectBinding | undefined;
}) {
  const projects = useProjects().filter((item) => item.environmentId === environmentId);
  const { environments } = useEnvironments();
  const [mapping, setMapping] = useState<Readonly<Record<string, ProjectId | undefined>>>(() =>
    Object.fromEntries(
      (binding?.detached ? [] : (binding?.roots ?? [])).map((root) => [
        root.rootId,
        root.projectId,
      ]),
    ),
  );
  const [paused, setPaused] = useState(binding?.paused ?? true);
  const [choosingRoot, setChoosingRoot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const bind = useAtomCommand(sharedCapabilities.sharedProjectBind, { reportFailure: false });
  const unbind = useAtomCommand(sharedCapabilities.sharedProjectUnbind, { reportFailure: false });
  const publish = useAtomCommand(sharedCapabilities.sharedProjectPublish, { reportFailure: false });
  const canBind = useAtomValue(sharedCapabilities.sharedProjectBind.permissionAtom(environmentId));
  const canPublish = useAtomValue(
    sharedCapabilities.sharedProjectPublish.permissionAtom(environmentId),
  );
  const canUnbind = useAtomValue(
    sharedCapabilities.sharedProjectUnbind.permissionAtom(environmentId),
  );
  const run = async (operation: "save" | "detach" | "archive") => {
    if (inFlight.current || (operation === "detach" && !binding)) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const bindingRevision = binding?.revision ?? 0;
    try {
      let result;
      if (operation === "detach") {
        result = await unbind({
          environmentId,
          input: { sharedProjectId: project.id, expectedBindingRevision: binding!.revision },
        });
      } else if (operation === "archive") {
        result = await publish({
          environmentId,
          input: {
            id: project.id,
            expectedRevision: project.revision,
            name: project.name,
            members: project.members,
            roots: project.roots,
            setupProfileId: project.setupProfileId,
            archived: !project.archived,
          },
        });
      } else {
        const roots = project.roots.flatMap((root) => {
          const projectId = mapping[root.id];
          return projectId ? [{ rootId: root.id, projectId }] : [];
        });
        result = await bind({
          environmentId,
          input: {
            sharedProjectId: project.id,
            expectedRevision: project.revision,
            expectedBindingRevision: bindingRevision,
            paused,
            roots,
          },
        });
      }
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    } catch {
      setError("Could not update this project. Refresh projects before retrying.");
    }
    inFlight.current = false;
    setBusy(false);
  };
  const confirm = (operation: "detach" | "archive") =>
    Alert.alert(
      operation === "detach"
        ? "Detach local mappings?"
        : project.archived
          ? "Restore project?"
          : "Archive project?",
      "Local project folders and files stay on disk.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Confirm", onPress: () => void run(operation) },
      ],
    );
  const complete = project.roots.every((root) =>
    projects.some((item) => item.id === mapping[root.id]),
  );
  const duplicate =
    new Set(project.roots.map((root) => mapping[root.id])).size !== project.roots.length;
  return (
    <View>
      <View className="p-4">
        <Text className="text-sm text-foreground-muted">
          {sharedProjectMappingStatus(project, binding, environmentId).detail}
        </Text>
        <Text className="text-xs text-foreground-muted">
          Members:{" "}
          {project.members.map((id) => sharedProjectMemberLabel(id, environments)).join(", ")}
        </Text>
      </View>
      {project.roots.map((root) => (
        <View key={root.id}>
          <ListActionRow
            label={`${root.name} (${root.kind === "git" ? "Git repository" : "Files"})`}
            description={
              projects.find((item) => item.id === mapping[root.id])?.workspaceRoot ??
              "Choose a local project"
            }
            disabled={busy || !canBind || project.archived}
            onPress={() => setChoosingRoot(choosingRoot === root.id ? null : root.id)}
          />
          {choosingRoot === root.id
            ? projects.map((item) => (
                <ListChoiceRow
                  key={item.id}
                  label={item.title}
                  description={item.workspaceRoot}
                  selected={mapping[root.id] === item.id}
                  disabled={busy}
                  onPress={() => {
                    setMapping({ ...mapping, [root.id]: item.id });
                    setChoosingRoot(null);
                  }}
                />
              ))
            : null}
        </View>
      ))}
      <ListToggleRow
        label="Pause preparation on this machine"
        value={paused}
        disabled={busy || !canBind || project.archived}
        onValueChange={setPaused}
      />
      {error || (complete && duplicate) ? (
        <View className="p-4">
          <Text>{error ?? "Each root needs a distinct local project folder."}</Text>
        </View>
      ) : null}
      <ListActionRow
        label="Save folder mappings"
        disabled={
          busy ||
          !canBind ||
          !complete ||
          duplicate ||
          project.archived ||
          !project.members.includes(environmentId)
        }
        onPress={() => void run("save")}
      />
      {binding && !binding.detached ? (
        <ListActionRow
          label="Detach local mappings"
          disabled={busy || !canUnbind}
          onPress={() => confirm("detach")}
        />
      ) : null}
      {project.ownerEnvironmentId === environmentId ? (
        <ListActionRow
          label={project.archived ? "Restore project" : "Archive project"}
          disabled={busy || !canPublish}
          onPress={() => confirm("archive")}
        />
      ) : null}
    </View>
  );
}
