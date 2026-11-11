import { useState } from "react";
import type { SetupProfileBinding, SetupProfileCommand } from "@t3tools/contracts";
import { setupProfilePresentation } from "@t3tools/client-runtime/setup-profile-presentation";
import { requestConfirmDialog } from "~/confirmDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

type Command = SetupProfileCommand;

export function SetupProfileBindingStatus({
  binding,
  label,
  allowed,
  busy,
  providerLabels,
  execute,
  refresh,
}: {
  readonly binding: SetupProfileBinding;
  readonly label: string;
  readonly allowed: boolean;
  readonly busy: boolean;
  readonly providerLabels: ReadonlyMap<string, string>;
  readonly execute: (input: Command | ReadonlyArray<Command>) => Promise<boolean>;
  readonly refresh: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const summary = setupProfilePresentation(binding);
  const visibleItems = binding.items.filter((item) =>
    `${item.name} ${providerLabels.get(item.instanceId) ?? item.instanceId} ${item.kind} ${item.status}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <div className="space-y-3">
      <SettingsRow
        title={binding.profile.name}
        description={`Applied revision ${binding.appliedRevision} · Latest revision ${binding.observedRevision}`}
        control={
          <Badge
            variant={
              summary.state === "verified"
                ? "success"
                : summary.state === "failed"
                  ? "error"
                  : summary.needsAttention > 0
                    ? "warning"
                    : "secondary"
            }
          >
            {summary.title}
          </Badge>
        }
      />
      <p
        role={summary.state === "failed" ? "alert" : "status"}
        className="px-4 text-sm text-muted-foreground"
      >
        {summary.description}
      </p>
      <SettingsRow
        title="Automatic sync"
        description="Receive future changes from this profile. Existing setup stays in place while paused."
        control={
          <Switch
            aria-label="Automatically sync this setup"
            checked={binding.enabled && !binding.detached}
            disabled={!allowed || busy || binding.detached}
            onCheckedChange={(enabled) => void execute({ operation: "pause", paused: !enabled })}
          />
        }
      />
      <details className="space-y-3 px-4">
        <summary className="cursor-pointer text-sm font-medium">
          MCP connections, skills and hooks · {summary.configured} configured · {summary.verified}{" "}
          verified · {summary.needsAttention} need attention
        </summary>
        <Input
          aria-label="Filter setup items"
          placeholder="Find a tool, skill or harness"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="max-h-80 overflow-y-auto divide-y divide-border">
          {visibleItems.map((item) => (
            <div
              key={`${item.instanceId}:${item.kind}:${item.name}`}
              className="flex items-start justify-between gap-4 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {providerLabels.get(item.instanceId) ?? item.instanceId} ·{" "}
                  {item.kind === "mcp"
                    ? "MCP connection"
                    : item.kind === "hook"
                      ? "Lifecycle hooks"
                      : "Skill"}
                </p>
                {item.message ? (
                  <p className="break-words text-xs text-muted-foreground">{item.message}</p>
                ) : null}
              </div>
              <Badge
                variant={
                  item.status === "verified"
                    ? "success"
                    : item.status === "failed"
                      ? "error"
                      : "secondary"
                }
              >
                {item.status.replaceAll("-", " ")}
              </Badge>
            </div>
          ))}
          {!visibleItems.length ? (
            <p className="py-3 text-sm text-muted-foreground">No setup items match this filter.</p>
          ) : null}
        </div>
      </details>
      {(binding.conflicts?.length ?? 0) > 0 ? (
        <details className="space-y-3 px-4" open>
          <summary className="cursor-pointer text-sm font-medium">
            Review {binding.conflicts!.length} local file changes
          </summary>
          <p className="text-xs text-muted-foreground">
            Keep local preserves this environment’s version. Use profile replaces it with the shared
            version.
          </p>
          {binding.conflicts!.map((path) => (
            <div key={path} className="space-y-2 border-b border-border pb-3">
              <p className="break-all text-xs text-muted-foreground">{path}</p>
              <div className="flex flex-wrap gap-2">
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
                  onClick={async () => {
                    if (
                      await requestConfirmDialog(
                        `Replace the local file on ${label} with the profile version?\n${path}`,
                      )
                    )
                      await execute({ operation: "resolve", path, resolution: "use-profile" });
                  }}
                >
                  Use profile
                </Button>
              </div>
            </div>
          ))}
        </details>
      ) : null}
      {binding.items.some((item) => item.status === "needs-secret") ? (
        <div className="space-y-3 px-4">
          <label className="block space-y-1 text-sm">
            Credential reference
            <Input value={secretName} onChange={(event) => setSecretName(event.target.value)} />
          </label>
          <label className="block space-y-1 text-sm">
            Credential value
            <Input
              type="password"
              value={secretValue}
              onChange={(event) => setSecretValue(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={!allowed || busy || !secretName || !secretValue}
            onClick={async () => {
              if (
                await execute({ operation: "bind-secret", name: secretName, secret: secretValue })
              )
                setSecretValue("");
            }}
          >
            Save credential on {label}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 px-4">
        <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
          Refresh status
        </Button>
        {summary.canRetry ? (
          <Button
            size="sm"
            disabled={!allowed || busy}
            onClick={() => void execute({ operation: "reconcile" })}
          >
            {busy ? "Retrying…" : "Retry setup"}
          </Button>
        ) : null}
      </div>
      <details className="space-y-3 px-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Disconnect or remove setup
        </summary>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!allowed || busy}
            onClick={async () => {
              if (
                await requestConfirmDialog(
                  `Disconnect ${label} from this setup profile?\nIts current MCP connections and skills stay installed. Future profile changes will stop.`,
                )
              )
                await execute({ operation: "detach", removeManaged: false });
            }}
          >
            Disconnect and keep setup
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!allowed || busy}
            onClick={async () => {
              if (
                await requestConfirmDialog(
                  `Remove profile-managed setup from ${label}?\nT3 will remove the connections and skill files managed by this profile. Other setup is retained.`,
                  { variant: "destructive" },
                )
              )
                await execute({ operation: "detach", removeManaged: true });
            }}
          >
            Remove managed setup
          </Button>
        </div>
      </details>
    </div>
  );
}
