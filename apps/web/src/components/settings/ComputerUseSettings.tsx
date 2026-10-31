import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { serverEnvironment } from "~/state/server";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

export function ComputerUseSettings({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(sharedCapabilities.computerCommand.permissionAtom(environmentId));
  const supported = config?.environment.capabilities.computerUse === 1;
  const state = useEnvironmentQuery(
    supported && allowed ? sharedCapabilities.computerState({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(sharedCapabilities.computerCommand, { reportFailure: false });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [apps, setApps] = useState<string | null>(null);
  const [providers, setProviders] = useState<ReadonlyArray<ProviderInstanceId> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = state.data?.config;
  const providerIds = providers ?? value?.providerInstanceIds ?? [];
  if (!supported) return null;
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    const result = await command({ environmentId, input });
    if (isAtomCommandInterrupted(result) || result._tag === "Failure")
      setError("Desktop settings could not be changed.");
    else {
      setError(null);
      state.refresh();
    }
  };
  return (
    <SettingsSection title={`Computer use · ${label}`}>
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Let selected harnesses use allowed apps through Cua Driver. One thread owns the desktop at
          a time. OS permissions stay on this machine.
        </p>
        <p className="text-sm">
          {state.data?.readiness ?? "Checking"} · {state.data?.message}
        </p>
        {error || state.error ? <p role="alert">{error ?? state.error}</p> : null}
        {state.data?.lease ? (
          <div className="rounded border p-3">
            <p>
              Controlled by {state.data.lease.label} · {state.data.lease.bundleId}
            </p>
            <Button
              variant="destructive"
              disabled={!allowed}
              onClick={() => void run({ operation: "release" })}
            >
              Release desktop
            </Button>
          </div>
        ) : (
          <p className="text-sm">No desktop lease</p>
        )}
        <fieldset disabled={!allowed} className="space-y-3">
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled ?? value?.enabled ?? false}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable computer use
          </label>
          <Input
            aria-label="Cua Driver executable"
            value={path ?? value?.command ?? "cua-driver"}
            onChange={(e) => setPath(e.target.value)}
          />
          <Input
            aria-label="Allowed desktop apps"
            placeholder="Allowed app bundle IDs, separated by commas"
            value={apps ?? value?.allowedApps.join(", ") ?? ""}
            onChange={(e) => setApps(e.target.value)}
          />
          {config?.providers.map((p) => (
            <label key={p.instanceId} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={providerIds.includes(p.instanceId)}
                onChange={(e) =>
                  setProviders(
                    e.target.checked
                      ? [...providerIds, p.instanceId]
                      : providerIds.filter((id) => id !== p.instanceId),
                  )
                }
              />
              {p.displayName ?? p.instanceId}
            </label>
          ))}
          <div className="flex gap-2">
            <Button
              onClick={() =>
                void run({
                  operation: "configure",
                  config: {
                    enabled: enabled ?? value?.enabled ?? false,
                    command: path ?? value?.command ?? "cua-driver",
                    allowedApps: (apps ?? value?.allowedApps.join(",") ?? "")
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    providerInstanceIds: providerIds,
                  },
                })
              }
            >
              Save desktop access
            </Button>
            <Button variant="outline" onClick={() => state.refresh()}>
              Check permissions
            </Button>
            <Button variant="outline" onClick={() => void run({ operation: "inherit" })}>
              Use profile desktop policy
            </Button>
          </div>
          <a
            className="text-sm underline"
            href="https://cua.ai/docs/cua-driver/quickstart"
            target="_blank"
            rel="noreferrer"
          >
            Install Cua Driver and set OS permissions
          </a>
        </fieldset>
      </div>
    </SettingsSection>
  );
}
