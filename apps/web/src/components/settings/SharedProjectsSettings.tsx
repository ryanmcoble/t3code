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
import { useRef, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SharedProjectEnrollmentSettings } from "./SharedProjectEnrollmentSettings";

export function SharedProjectsSettings({
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
    <SettingsSection
      title="Shared projects"
      headerAction={
        <Button size="sm" variant="ghost" onClick={state.refresh}>
          Refresh projects
        </Button>
      }
    >
      <SettingsRow
        title="One project, multiple folders"
        description="Choose member machines and map shared roots to local projects. Folder mappings preserve existing files; they do not establish synchronization or execution readiness."
      />
      {config?.environment.capabilities.sharedProjectEnrollment === 1 ? (
        <SharedProjectEnrollmentSettings
          environmentId={environmentId}
          projects={state.data?.projects ?? []}
        />
      ) : null}
      {state.error ? (
        <SettingsRow
          title="Could not load shared projects"
          description={state.error}
          role="alert"
        />
      ) : !state.data ? (
        <SettingsRow title="Loading shared projects…" role="status" />
      ) : null}
      {state.data && !state.data.complete ? (
        <SettingsRow
          title="Partial project list"
          description="Only the first 200 shared projects and mappings are shown."
        />
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
        <SettingsRow
          title="No shared projects"
          description="Start with registered project folders on this machine. Other machines keep their own local paths."
        />
      ) : null}
      {creating ? (
        <CreateSharedProject
          key={environmentId}
          environmentId={environmentId}
          onClose={() => setCreating(false)}
        />
      ) : (
        <SettingsRow
          title="Create a shared project"
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!allowed || !state.data?.complete}
              onClick={() => setCreating(true)}
            >
              Create project
            </Button>
          }
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
  const [id] = useState(randomUUID);
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
    <div className="space-y-3 border-t border-border p-4">
      <label className="block space-y-1 text-sm">
        Project name
        <Input
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
      </label>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="text-sm font-medium">Member machines</legend>
        {environments.map((machine) => (
          <label key={machine.environmentId} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={members.includes(machine.environmentId)}
              disabled={machine.environmentId === environmentId}
              onChange={(event) =>
                setMembers(
                  event.target.checked
                    ? [...members, machine.environmentId]
                    : members.filter((id) => id !== machine.environmentId),
                )
              }
            />
            {machine.label}
            {machine.environmentId === environmentId ? " (owner)" : ""}
          </label>
        ))}
      </fieldset>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="text-sm font-medium">Project folders</legend>
        {projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add a local project before creating a shared project.
          </p>
        ) : (
          projects.map((project) => {
            const root = roots.find((root) => root.projectId === project.id);
            return (
              <div key={project.id} className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!root}
                    disabled={!root && roots.length >= 16}
                    onChange={(event) =>
                      setRoots(
                        event.target.checked
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
                  {project.title}
                </label>
                <p className="break-all text-xs text-muted-foreground">{project.workspaceRoot}</p>
                {root ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={root.kind === "git"}
                      onChange={(event) =>
                        setRoots(
                          roots.map((item) =>
                            item.projectId === project.id
                              ? { ...item, kind: event.target.checked ? "git" : "files" }
                              : item,
                          ),
                        )
                      }
                    />
                    Git repository
                  </label>
                ) : null}
              </div>
            );
          })
        )}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Local credentials, native application state, dependencies and generated outputs stay
        excluded. Review local mappings after creating the project.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !name.trim() || roots.length === 0}
          onClick={() => void save()}
        >
          {busy ? "Creating…" : "Create shared project"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
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
  const owner = sharedProjectMemberLabel(project.ownerEnvironmentId, environments);
  return (
    <div className="border-t border-border">
      <SettingsRow
        title={project.name}
        description={`${status.title}. Owner: ${owner}. Revision ${project.revision}.`}
        control={
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide mappings" : "Manage folders"}
          </Button>
        }
      />
      {expanded ? (
        <ProjectMappings
          key={`${project.revision}:${binding?.revision ?? 0}`}
          environmentId={environmentId}
          project={project}
          binding={binding}
        />
      ) : null}
    </div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const status = sharedProjectMappingStatus(project, binding, environmentId);
  const inFlight = useRef(false);
  const run = async (operation: "save" | "detach" | "archive") => {
    if (inFlight.current || (operation === "detach" && !binding)) return;
    if (
      operation !== "save" &&
      !(await requestConfirmDialog(
        operation === "detach"
          ? "Detach these local mappings? Local project folders and files stay on disk."
          : `${project.archived ? "Restore" : "Archive"} this shared project? Local folders stay on disk.`,
      ))
    )
      return;
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
  const complete = project.roots.every((root) =>
    projects.some((item) => item.id === mapping[root.id]),
  );
  const duplicate =
    new Set(project.roots.map((root) => mapping[root.id])).size !== project.roots.length;
  return (
    <div className="space-y-3 px-4 pb-4">
      <p className="text-xs text-muted-foreground">{status.detail}</p>
      <p className="text-xs text-muted-foreground">
        Members:{" "}
        {project.members.map((id) => sharedProjectMemberLabel(id, environments)).join(", ")}
      </p>
      {project.roots.map((root) => (
        <div key={root.id} className="space-y-1">
          <label className="block text-sm">
            {root.name} ({root.kind === "git" ? "Git repository" : "Files"})
          </label>
          <Select
            value={mapping[root.id] ?? ""}
            onValueChange={(value) => {
              const item = projects.find((item) => item.id === value);
              setMapping({ ...mapping, [root.id]: item?.id });
            }}
            disabled={busy || project.archived || !canBind}
          >
            <SelectTrigger aria-label={`Local folder for ${root.name}`}>
              <SelectValue>
                {projects.find((item) => item.id === mapping[root.id])?.title ??
                  "Choose a local project"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title} · {item.workspaceRoot}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="break-all text-xs text-muted-foreground">
            {projects.find((item) => item.id === mapping[root.id])?.workspaceRoot}
          </p>
        </div>
      ))}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={paused}
          disabled={busy || !canBind || project.archived}
          onChange={(event) => setPaused(event.target.checked)}
        />
        Pause preparation on this machine
      </label>
      {duplicate && complete ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          Each root needs a distinct local project folder.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            busy ||
            !canBind ||
            !complete ||
            duplicate ||
            project.archived ||
            !project.members.includes(environmentId)
          }
          onClick={() => void run("save")}
        >
          Save folder mappings
        </Button>
        {binding && !binding.detached ? (
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy || !canUnbind}
            onClick={() => void run("detach")}
          >
            Detach local mappings
          </Button>
        ) : null}
        {project.ownerEnvironmentId === environmentId ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !canPublish}
            onClick={() => void run("archive")}
          >
            {project.archived ? "Restore project" : "Archive project"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
