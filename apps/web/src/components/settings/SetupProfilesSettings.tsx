import { randomUUID } from "~/lib/utils";
import { SetupMcpEditor } from "./SetupMcpEditor";
import { SetupProfileEnrollment } from "./SetupProfileEnrollment";
import { useAtomValue } from "@effect/atom-react";
import {
  SetupMcpConnection,
  MemoryScopeReference,
  ComputerUseProfilePolicy,
  type SetupProfile,
  type EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import { setupProfiles } from "~/state/setupProfiles";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const encodeConnections = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(SetupMcpConnection)),
);
const decodeConnections = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(SetupMcpConnection)),
);

const ProfilePolicy = Schema.Struct({
  memoryScopes: Schema.Array(MemoryScopeReference),
  computerUse: Schema.NullOr(ComputerUseProfilePolicy),
});
const encodePolicy = Schema.encodeSync(Schema.fromJsonString(ProfilePolicy));
const decodePolicy = Schema.decodeUnknownSync(Schema.fromJsonString(ProfilePolicy));

export function SetupProfilesSettings({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.setupProfiles === 1;
  const state = useEnvironmentQuery(
    supported ? setupProfiles.state({ environmentId, input: {} }) : null,
  );
  const run = useAtomCommand(setupProfiles.command, { reportFailure: false });
  const importSetup = useAtomCommand(setupProfiles.importSetup, { reportFailure: false });
  const grant = useAtomCommand(setupProfiles.grant, { reportFailure: false });
  const allowed = useAtomValue(setupProfiles.command.permissionAtom(environmentId));
  const canGrant = useAtomValue(setupProfiles.grant.permissionAtom(environmentId));
  const [editing, setEditing] = useState<SetupProfile | null>(null);
  const [name, setName] = useState("Development setup");
  const [connections, setConnections] = useState("[]");
  const [skillPaths, setSkillPaths] = useState("");
  const [policyText, setPolicyText] = useState(
    encodePolicy({ memoryScopes: [], computerUse: null }),
  );
  const [skills, setSkills] = useState<SetupProfile["skills"]>([]);
  const [instanceId, setInstanceId] = useState("");
  const [selectedIds, setInstanceIds] = useState<ReadonlyArray<string> | null>(null);
  const instanceIds = selectedIds ?? state.data?.binding?.instanceIds ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [token, setToken] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [grantProfile, setGrantProfile] = useState("");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "subscription credential",
    onError: (error) => setError(error.message),
  });
  const [draftId, setDraftId] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const providers = config?.providers ?? [];
  type SetupCommandInput = Parameters<typeof run>[0]["input"];
  const execute = async (input: SetupCommandInput | ReadonlyArray<SetupCommandInput>) => {
    setBusy(true);
    setError(null);
    try {
      const commands = "operation" in input ? [input] : input;
      for (const command of commands) {
        const result = await run({ environmentId, input: command });
        if (isAtomCommandInterrupted(result) || result._tag === "Failure") {
          setError(
            "The setup operation failed. Refresh and check this environment's access and status.",
          );
          return false;
        }
      }
      return true;
    } finally {
      state.refresh();
      setBusy(false);
    }
  };
  const edit = (profile: SetupProfile | null) => {
    setEditing(profile);
    setDraftId(profile?.id ?? randomUUID());
    setName(profile?.name ?? "Development setup");
    setConnections(profile ? encodeConnections(profile.connections) : "[]");
    setSkills(profile?.skills ?? []);
    setPolicyText(
      encodePolicy({
        memoryScopes: profile?.memoryScopes ?? [],
        computerUse: profile?.computerUse ?? null,
      }),
    );
    setEditorOpen(true);
  };
  if (!supported)
    return (
      <SettingsSection title={`Setup profiles · ${label}`}>
        <SettingsRow
          title="Server update required"
          description="This environment does not support setup profiles yet."
        />
      </SettingsSection>
    );
  const binding = state.data?.binding;
  return (
    <SettingsSection title={`Setup profiles · ${label}`}>
      <div className="space-y-4 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Share selected MCP connections and complete skill packages across environments. Each
          environment keeps its own account sign-ins.
        </p>
        {state.error ? <p role="alert">{state.error}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {binding ? (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">
              {binding.profile.name} · revision {binding.profile.revision}
            </p>
            <p className="text-xs text-muted-foreground">
              Applied revision {binding.appliedRevision} ·{" "}
              {binding.detached
                ? "Detached; current setup retained"
                : binding.enabled
                  ? "Automatic synchronization on"
                  : "Automatic synchronization off"}
            </p>
            {binding.error ? (
              <p role="alert" className="text-sm">
                {binding.error}
              </p>
            ) : null}
            <details className="space-y-2">
              <summary className="cursor-pointer text-sm">
                Setup items ({binding.items.length})
              </summary>
              {binding.items.map((item) => (
                <p className="text-xs" key={`${item.instanceId}:${item.kind}:${item.name}`}>
                  {item.instanceId} · {item.name}: {item.status} · {item.message}
                </p>
              ))}
            </details>
            {(binding.conflicts?.length ?? 0) > 0 ? (
              <details className="space-y-2">
                <summary className="cursor-pointer text-sm">
                  Review local file conflicts ({binding.conflicts!.length})
                </summary>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!allowed || busy}
                  onClick={() =>
                    void execute(
                      binding.conflicts!.map((path): SetupCommandInput => ({
                        operation: "resolve",
                        path,
                        resolution: "use-profile",
                      })),
                    )
                  }
                >
                  Use profile for all listed conflicts
                </Button>
                {(binding.conflicts ?? []).map((path) => (
                  <div key={path} className="space-y-1 rounded border p-2">
                    <p className="break-all text-xs">{path}</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!allowed || busy}
                        onClick={() =>
                          void execute({ operation: "resolve", path, resolution: "keep-local" })
                        }
                      >
                        Keep local
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!allowed || busy}
                        onClick={() =>
                          void execute({ operation: "resolve", path, resolution: "use-profile" })
                        }
                      >
                        Use profile
                      </Button>
                    </div>
                  </div>
                ))}
              </details>
            ) : null}
            {binding.items.some((item) => item.status === "needs-secret") ? (
              <div className="space-y-2">
                <p className="text-sm">Bind a credential on this environment</p>
                <Input
                  aria-label="Credential reference name"
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="Secret reference name"
                />
                <Input
                  aria-label="Credential value"
                  type="password"
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={!allowed || busy || !secretName || !secretValue}
                  onClick={async () => {
                    if (
                      await execute({
                        operation: "bind-secret",
                        name: secretName,
                        secret: secretValue,
                      })
                    )
                      setSecretValue("");
                  }}
                >
                  Save credential locally
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => state.refresh()}>
                Refresh status
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!allowed || busy}
                onClick={() => void execute({ operation: "reconcile" })}
              >
                Retry setup
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!allowed || busy}
                onClick={() => void execute({ operation: "pause", paused: binding.enabled })}
              >
                {binding.enabled ? "Pause sync" : "Resume sync"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!allowed || busy}
                onClick={() => void execute({ operation: "detach", removeManaged: false })}
              >
                Detach and keep setup
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={!allowed || busy}
                onClick={() => void execute({ operation: "detach", removeManaged: true })}
              >
                Remove managed setup
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm">No setup profile applied.</p>
        )}
        <fieldset disabled={!allowed || busy} className="space-y-2">
          <legend className="text-sm font-medium">Target harnesses</legend>
          {providers.map((p) => (
            <label className="flex items-center gap-2 text-sm" key={p.instanceId}>
              <input
                type="checkbox"
                checked={instanceIds.includes(p.instanceId)}
                onChange={(e) =>
                  setInstanceIds(
                    e.target.checked
                      ? [...instanceIds, p.instanceId]
                      : instanceIds.filter((id) => id !== p.instanceId),
                  )
                }
              />
              {p.displayName ?? p.driver}
            </label>
          ))}
        </fieldset>
        <SetupProfileEnrollment
          destinationId={environmentId}
          instanceIds={instanceIds.map((id) => ProviderInstanceId.make(id))}
          onEnrolled={state.refresh}
        />
        {state.data?.profiles.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2">
            <span className="text-sm">
              {p.name} · revision {p.revision}
            </span>
            <Button size="sm" variant="outline" disabled={!allowed || busy} onClick={() => edit(p)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!allowed || busy || !instanceIds.length}
              onClick={() =>
                void execute({
                  operation: "apply",
                  profileId: p.id,
                  instanceIds: instanceIds.map((id) => ProviderInstanceId.make(id)),
                  subscribe: false,
                })
              }
            >
              Apply once
            </Button>
            <Button
              size="sm"
              disabled={!allowed || busy || !instanceIds.length}
              onClick={() =>
                void execute({
                  operation: "apply",
                  profileId: p.id,
                  instanceIds: instanceIds.map((id) => ProviderInstanceId.make(id)),
                  subscribe: true,
                })
              }
            >
              Apply and keep synchronized
            </Button>
          </div>
        ))}
        <Button variant="outline" disabled={!allowed || busy} onClick={() => edit(null)}>
          Create setup profile
        </Button>
        {editorOpen ? (
          <fieldset disabled={!allowed || busy} className="space-y-3 rounded-lg border p-3">
            <label className="block space-y-1 text-sm">
              Profile name
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block space-y-1 text-sm">
              Import MCP connections from
              <select
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
                className="block rounded border bg-background p-2"
              >
                <option value="">Choose a harness</option>
                {providers.map((p) => (
                  <option key={p.instanceId} value={p.instanceId}>
                    {p.displayName ?? p.driver}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              Skill folders on this environment, one per line
              <Textarea value={skillPaths} onChange={(e) => setSkillPaths(e.target.value)} />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={!instanceId}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const result = await importSetup({
                    environmentId,
                    input: {
                      instanceId: ProviderInstanceId.make(instanceId),
                      skillPaths: skillPaths
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                  });
                  if (isAtomCommandInterrupted(result) || result._tag === "Failure") {
                    setError("Import failed. Check the selected folders and native configuration.");
                    return;
                  }
                  let previous: ReadonlyArray<SetupMcpConnection>;
                  try {
                    previous = decodeConnections(connections);
                  } catch {
                    setError("Fix the connection definitions before merging an import.");
                    return;
                  }
                  setConnections(
                    encodeConnections([
                      ...new Map(
                        [...previous, ...result.value.connections].map((c) => [c.name, c]),
                      ).values(),
                    ]),
                  );
                  setSkills((previous) => [
                    ...new Map(
                      [...previous, ...result.value.skills].map((skill) => [skill.name, skill]),
                    ).values(),
                  ]);
                  setNotice(result.value.warnings.join(" "));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Import selected setup
            </Button>
            <details>
              <summary>Shared memory and desktop policy</summary>
              <p className="text-xs text-muted-foreground">
                Memory references identify the owner and scope; each destination still chooses its
                projects and grants access. Desktop policy applies where no local override exists.
              </p>
              <Textarea
                aria-label="Profile memory and desktop policy"
                value={policyText}
                onChange={(e) => setPolicyText(e.target.value)}
              />
            </details>
            <SetupMcpEditor value={connections} onChange={setConnections} />
            {skills.map((skill) => (
              <div key={skill.name} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {skill.name} · {skill.files.length} files
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSkills(skills.filter((entry) => entry.name !== skill.name))}
                >
                  Remove skill
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              {skills.length} complete skill packages selected. Credential references are resolved
              independently on each destination.
            </p>
            <Button
              onClick={async () => {
                let parsed: ReadonlyArray<SetupMcpConnection>;
                let policy: typeof ProfilePolicy.Type;
                try {
                  parsed = decodeConnections(connections);
                  policy = decodePolicy(policyText);
                } catch {
                  setError("The MCP connection definitions are invalid.");
                  return;
                }
                if (
                  await execute({
                    operation: "publish",
                    profile: {
                      id: editing?.id ?? draftId,
                      name,
                      expectedRevision: editing?.revision ?? 0,
                      connections: parsed,
                      skills,
                      memoryScopes: policy.memoryScopes,
                      ...(policy.computerUse ? { computerUse: policy.computerUse } : {}),
                    },
                  })
                )
                  setEditorOpen(false);
              }}
            >
              Publish profile
            </Button>
          </fieldset>
        ) : null}
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium">
            Connect a profile from another environment
          </summary>
          <p className="text-xs text-muted-foreground">
            Create subscription access on the owner, then use it here. The owner address must be
            reachable by this server.
          </p>
          <fieldset disabled={!allowed || busy} className="space-y-2 pt-2">
            <Input
              aria-label="Profile owner address"
              placeholder="https://owner.example.ts.net:8443"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
            <Input
              aria-label="Profile owner environment ID"
              placeholder="Owner environment ID"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            />
            <Input
              aria-label="Profile ID"
              placeholder="Profile ID"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            />
            <Input
              aria-label="Subscription credential"
              placeholder="Subscription credential"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              disabled={!instanceIds.length || !sourceId || !sourceUrl || !profileId || !token}
              onClick={async () => {
                if (
                  await execute({
                    operation: "subscribe",
                    profileId,
                    ownerEnvironmentId: sourceId as EnvironmentId,
                    sourceUrl,
                    token,
                    instanceIds: instanceIds.map((id) => ProviderInstanceId.make(id)),
                  })
                )
                  setToken("");
              }}
            >
              Subscribe this environment
            </Button>
          </fieldset>
        </details>
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium">
            Manage subscription access
          </summary>
          <fieldset disabled={!canGrant || busy} className="space-y-2 pt-2">
            <select
              aria-label="Owned setup profile"
              value={grantProfile}
              onChange={(e) => setGrantProfile(e.target.value)}
              className="rounded border bg-background p-2"
            >
              <option value="">Choose an owned profile</option>
              {state.data?.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.id}
                </option>
              ))}
            </select>
            <Input
              aria-label="Destination environment ID"
              placeholder="Destination environment ID"
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
            />
            <Button
              disabled={!grantProfile || !destinationId}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await grant({
                    environmentId,
                    input: {
                      profileId: grantProfile,
                      destinationEnvironmentId: destinationId as EnvironmentId,
                      revoke: false,
                    },
                  });
                  if (!isAtomCommandInterrupted(result) && result._tag === "Success")
                    setIssuedToken(result.value.token);
                  else setError("Subscription access could not be created.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create subscription access
            </Button>
            <Button
              variant="outline"
              disabled={!grantProfile || !destinationId}
              onClick={async () => {
                const result = await grant({
                  environmentId,
                  input: {
                    profileId: grantProfile,
                    destinationEnvironmentId: destinationId as EnvironmentId,
                    revoke: true,
                  },
                });
                if (!isAtomCommandInterrupted(result) && result._tag === "Success") {
                  setIssuedToken(null);
                  setNotice("Subscription access revoked.");
                }
              }}
            >
              Revoke subscription access
            </Button>
            {issuedToken ? (
              <label className="block text-sm">
                Subscription credential
                <Input
                  readOnly
                  type="password"
                  value={issuedToken}
                  onFocus={(e) => e.target.select()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(issuedToken, undefined)}
                >
                  {isCopied ? "Copied" : "Copy subscription credential"}
                </Button>
                <span className="text-xs">
                  Profile {grantProfile} · owner {environmentId}
                </span>
              </label>
            ) : null}
          </fieldset>
        </details>
      </div>
    </SettingsSection>
  );
}
