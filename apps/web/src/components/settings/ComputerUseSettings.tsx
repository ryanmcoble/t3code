import { useAtomValue } from "@effect/atom-react";
import { ComputerAppAccessPicker } from "./ComputerAppAccessPicker";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { serverEnvironment } from "~/state/server";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

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
  const [apps, setApps] = useState<ReadonlyArray<string> | null>(null);
  const [providers, setProviders] = useState<ReadonlyArray<ProviderInstanceId> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = state.data?.config;
  const providerIds = providers ?? value?.providerInstanceIds ?? [];
  if (!supported) return null;
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    setBusy(true);
    const result = await command({ environmentId, input });
    setBusy(false);
    if (isAtomCommandInterrupted(result) || result._tag === "Failure") {
      setError("Desktop settings could not be changed. Check access and setup, then try again.");
      return false;
    }
    setError(null);
    setEnabled(null);
    setApps(null);
    setPath(null);
    setProviders(null);
    state.refresh();
    return true;
  };
  const checks = state.data?.checks;
  const isEnabled = enabled ?? value?.enabled ?? false;
  const selectedApps = apps ?? value?.allowedApps ?? [];
  const enabledProviders = config?.providers.filter((provider) => provider.enabled) ?? [];
  const setupChecks = [
    {
      name: "Cua Driver",
      status:
        checks?.driver === "available"
          ? "Available"
          : checks?.driver === "unsupported-version"
            ? "Update needed"
            : "Check installation",
    },
    {
      name: "Accessibility",
      status:
        checks?.accessibility === true
          ? "Allowed"
          : checks?.accessibility === false
            ? "Needs approval on this Mac"
            : "Not checked",
    },
    {
      name: "Screen Recording",
      status:
        checks?.screenRecording === true
          ? "Allowed"
          : checks?.screenRecording === false
            ? "Needs approval on this Mac"
            : "Not checked",
    },
    { name: "Agent verification", status: "Observe an allowed app to verify capture" },
  ];
  return (
    <SettingsSection id="computer-use" title={`Computer use · ${label}`}>
      <SettingsRow
        title="Desktop access"
        description="Only the selected harnesses and apps may use this desktop. One thread controls it at a time."
        control={
          <Badge variant={state.data?.readiness === "ready" ? "info" : "secondary"}>
            {state.data?.readiness === "ready"
              ? "Permissions available"
              : isEnabled
                ? "Setup needs attention"
                : "Not enabled"}
          </Badge>
        }
      />
      <div className="space-y-3 px-4 py-3">
        {error || state.error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error ?? state.error}
          </p>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          {state.data?.message ?? "Checking this environment…"}
        </p>
        <dl className="divide-y divide-border">
          {setupChecks.map((check) => (
            <div key={check.name} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
              <dt>{check.name}</dt>
              <dd className="text-muted-foreground">{check.status}</dd>
            </div>
          ))}
        </dl>
        {!value?.enabled && !providerIds.length && !selectedApps.length ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Start with Calculator and your enabled harnesses:{" "}
              {enabledProviders
                .map((provider) => provider.displayName ?? provider.driver)
                .join(", ") || "none enabled"}
              . Add other apps below when needed.
            </p>
            <Button
              disabled={!allowed || busy || !enabledProviders.length}
              onClick={async () => {
                if (
                  await requestConfirmDialog(
                    `Enable computer use on ${label} for Calculator only?\nAllowed harnesses: ${enabledProviders.map((provider) => provider.displayName ?? provider.driver).join(", ")}. OS permissions remain on this Mac.`,
                  )
                ) {
                  const ids = enabledProviders.map((provider) => provider.instanceId);
                  const saved = await run({
                    operation: "configure",
                    config: {
                      enabled: true,
                      command: value?.command ?? "cua-driver",
                      allowedApps: ["com.apple.calculator"],
                      providerInstanceIds: ids,
                    },
                  });
                  if (saved) {
                    setProviders(ids);
                    setApps(["com.apple.calculator"]);
                    setEnabled(true);
                  }
                }
              }}
            >
              {busy ? "Setting up…" : "Set up with Calculator"}
            </Button>
          </div>
        ) : null}
        <Button
          variant="outline"
          disabled={busy || state.isPending}
          onClick={() => state.refresh()}
        >
          Check setup again
        </Button>
        {checks && (checks.accessibility !== true || checks.screenRecording !== true) ? (
          <p className="text-xs text-muted-foreground">
            On {label}, open System Settings → Privacy & Security and allow Cua Driver under
            Accessibility and Screen Recording. Then check setup again.
          </p>
        ) : null}
      </div>
      {state.data?.lease ? (
        <SettingsRow
          title={`Controlled by ${state.data.lease.label}`}
          description={state.data.lease.bundleId}
          control={
            <Button
              variant="outline"
              disabled={!allowed || busy}
              onClick={() => void run({ operation: "release" })}
            >
              Release desktop
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        title="Enable computer use"
        control={
          <Switch
            aria-label="Enable computer use"
            checked={isEnabled}
            disabled={!allowed || busy}
            onCheckedChange={setEnabled}
          />
        }
      />
      <fieldset disabled={!allowed || busy} className="space-y-3 px-4 py-3">
        <legend className="text-sm font-medium">Allowed harnesses</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {config?.providers.map((provider) => (
            <label key={provider.instanceId} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={providerIds.includes(provider.instanceId)}
                onCheckedChange={(checked) =>
                  setProviders(
                    checked
                      ? [...providerIds, provider.instanceId]
                      : providerIds.filter((id) => id !== provider.instanceId),
                  )
                }
              />
              {provider.displayName ?? provider.driver}
            </label>
          ))}
        </div>
        <ComputerAppAccessPicker
          rules={selectedApps}
          supportsRules={config?.environment.capabilities.computerUseAppRules === 1}
          applications={state.data?.availableApps ?? []}
          environmentLabel={label}
          disabled={!allowed || busy}
          onChange={setApps}
        />
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Advanced driver settings
          </summary>
          <label className="block space-y-1 text-sm">
            Cua Driver executable
            <Input
              value={path ?? value?.command ?? "cua-driver"}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
        </details>
        {isEnabled && (!providerIds.length || !selectedApps.length) ? (
          <p role="status" className="text-sm text-warning-foreground">
            Choose at least one harness and app before enabling desktop access.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              !allowed || busy || (isEnabled && (!providerIds.length || !selectedApps.length))
            }
            onClick={async () => {
              const broadRules = selectedApps.filter(
                (rule) =>
                  rule.includes("*") &&
                  (value?.appRulesVersion !== 1 || !value.allowedApps.includes(rule)),
              );
              if (
                isEnabled &&
                broadRules.length &&
                !(await requestConfirmDialog(
                  `Expand desktop access on ${label}?\nRules: ${broadRules.join(", ")}. The selected harnesses may observe and control every matching application.`,
                ))
              )
                return;
              await run({
                operation: "configure",
                config: {
                  enabled: isEnabled,
                  command: path ?? value?.command ?? "cua-driver",
                  allowedApps: selectedApps,
                  ...(config?.environment.capabilities.computerUseAppRules === 1
                    ? { appRulesVersion: 1 as const }
                    : {}),
                  providerInstanceIds: providerIds,
                },
              });
            }}
          >
            {busy ? "Saving…" : "Save desktop access"}
          </Button>
          <Button
            variant="outline"
            disabled={!allowed || busy}
            onClick={() => void run({ operation: "inherit" })}
          >
            Use profile policy
          </Button>
        </div>
        <a
          className="text-sm underline"
          href="https://cua.ai/docs/cua-driver/quickstart"
          target="_blank"
          rel="noreferrer"
        >
          Installation and macOS permission help
        </a>
      </fieldset>
    </SettingsSection>
  );
}
