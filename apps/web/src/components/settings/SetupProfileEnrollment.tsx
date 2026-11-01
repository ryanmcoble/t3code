import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { setupProfiles } from "~/state/setupProfiles";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

export function SetupProfileEnrollment({
  destinationId,
  instanceIds,
  onEnrolled,
}: {
  readonly destinationId: EnvironmentId;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly onEnrolled: () => void;
}) {
  const { environments } = useEnvironments();
  const owners = environments.filter(
    (e) =>
      e.environmentId !== destinationId &&
      e.serverConfig?.environment.capabilities.setupProfiles === 1,
  );
  const [selectedOwner, setSelectedOwner] = useState<string>("");
  const ownerId = selectedOwner
    ? EnvironmentId.make(selectedOwner)
    : (owners[0]?.environmentId ?? destinationId);
  const [selectedProfile, setSelectedProfile] = useState("");
  const profiles = useEnvironmentQuery(
    ownerId !== destinationId ? setupProfiles.state({ environmentId: ownerId, input: {} }) : null,
  );
  const canGrant = useAtomValue(setupProfiles.grant.permissionAtom(ownerId));
  const canApply = useAtomValue(setupProfiles.command.permissionAtom(destinationId));
  const enroll = useAtomCommand(setupProfiles.enroll, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = profiles.data?.profiles ?? [];
  const profileId = selectedProfile || available[0]?.id || "";
  const machine = linkableMachines({
    environments,
    threadEnvironmentId: destinationId,
    links: [],
    connect: new Map(),
  }).find((e) => e.environmentId === ownerId);
  const sourceUrl = machine?.urls.find((url) => url.startsWith("https://"));
  if (!owners.length) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Use a setup profile from another environment</p>
      <label className="block text-sm">
        Profile owner
        <select
          className="ml-2 rounded border bg-background p-2"
          value={ownerId}
          onChange={(e) => {
            setSelectedOwner(e.target.value);
            setSelectedProfile("");
          }}
        >
          {owners.map((e) => (
            <option key={e.environmentId} value={e.environmentId}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Setup profile
        <select
          className="ml-2 rounded border bg-background p-2"
          value={profileId}
          onChange={(e) => setSelectedProfile(e.target.value)}
        >
          {!available.length ? <option value="">No owned profiles available</option> : null}
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {!sourceUrl ? (
        <p className="text-xs text-muted-foreground">
          Add an HTTPS route to the profile owner that this server can reach, such as its Tailscale
          address.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
      <Button
        size="sm"
        disabled={busy || !canGrant || !canApply || !sourceUrl || !profileId || !instanceIds.length}
        onClick={async () => {
          setBusy(true);
          setError(null);
          return await (async () => {
            const result = await enroll({
              ownerId,
              destinationId,
              profileId,
              sourceUrl: sourceUrl!,
              instanceIds,
            });
            if (isAtomCommandInterrupted(result) || result._tag === "Failure")
              setError(
                "Could not enroll this environment. Check access on both machines and try again.",
              );
            else onEnrolled();
          })().finally(() => {
            setBusy(false);
          });
        }}
      >
        Apply profile and keep synchronized
      </Button>
    </div>
  );
}
