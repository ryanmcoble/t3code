import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { sharedProjectMemberLabel } from "@t3tools/client-runtime/state/shared-capabilities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SharedProjectManifest } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function SharedProjectEnrollmentSettings({
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
    if (inFlight.current) return;
    if (
      input?.operation === "disconnect" &&
      !(await requestConfirmDialog(
        "Disconnect this project owner and detach its local mappings? Project folders and files stay on disk. The owner can revoke its grant separately.",
      ))
    )
      return;
    if (!input && (!sourceUrl || !projectId)) return;
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
  return (
    <div className="space-y-3 border-t border-border p-4">
      <p className="text-sm font-medium">Follow a project owner</p>
      <p className="text-xs text-muted-foreground">
        Follow project definitions in the background. Choose local folders after enrolling. Project
        content and account sign-ins are not transferred by enrollment.
      </p>
      {owners.length ? (
        <>
          <Select
            value={ownerId}
            onValueChange={(value) => {
              const owner = owners.find((owner) => owner.environmentId === value);
              if (owner) {
                setSelectedOwner(owner.environmentId);
                setSelectedProject("");
              }
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label="Shared project owner">
              <SelectValue>{sharedProjectMemberLabel(ownerId, owners)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {owners.map((owner) => (
                <SelectItem key={owner.environmentId} value={owner.environmentId}>
                  {owner.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={projectId}
            onValueChange={(value) => setSelectedProject(value ?? "")}
            disabled={busy || !available.length}
          >
            <SelectTrigger aria-label="Shared project to follow">
              <SelectValue>
                {available.find((project) => project.id === projectId)?.name ??
                  "No selected projects"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {available.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {!available.length ? (
            <p className="text-xs text-muted-foreground">
              Select this machine as a project member on the owner first.
            </p>
          ) : null}
          {!sourceUrl ? (
            <p className="text-xs text-muted-foreground">
              Add an HTTPS route that this machine can use to reach the owner.
            </p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canGrant || !canConfigure || !sourceUrl || !projectId}
            onClick={() => void run(null)}
          >
            Enroll this machine
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Connect another environment with shared project enrollment to follow its projects.
        </p>
      )}
      {source.error || subscriptions.error || error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error ?? source.error ?? subscriptions.error}
        </p>
      ) : null}
      {!subscriptions.data ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading subscriptions…
        </p>
      ) : null}
      {subscriptions.data?.subscriptions.map((subscription) => (
        <div key={subscription.sharedProjectId} className="space-y-2 border-t border-border pt-3">
          <p className="text-sm">
            {projects.find((project) => project.id === subscription.sharedProjectId)?.name ??
              "Shared project"}{" "}
            · {sharedProjectMemberLabel(subscription.ownerEnvironmentId, environments)}
          </p>
          <p className="text-xs text-muted-foreground">
            {subscription.paused
              ? "Paused"
              : (subscription.error ??
                `Following project revision ${subscription.observedRevision}`)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !canConfigure}
              onClick={() =>
                void run({ operation: "refresh", sharedProjectId: subscription.sharedProjectId })
              }
            >
              Refresh owner
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canConfigure}
              onClick={() =>
                void run({
                  operation: "pause",
                  sharedProjectId: subscription.sharedProjectId,
                  paused: !subscription.paused,
                })
              }
            >
              {subscription.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy || !canConfigure}
              onClick={() =>
                void run({ operation: "disconnect", sharedProjectId: subscription.sharedProjectId })
              }
            >
              Disconnect
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
