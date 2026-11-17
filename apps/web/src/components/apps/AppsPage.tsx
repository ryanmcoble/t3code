import {
  standaloneAppSelection,
  rememberStandaloneAppSelection,
} from "@t3tools/client-runtime/standalone-apps";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { EnvironmentId, StandaloneAppDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { StandaloneAppView } from "./StandaloneAppView";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { requestConfirmDialog } from "../../confirmDialog";

const decodeAppManifest = Schema.decodeUnknownSync(StandaloneAppDefinition);

export function AppsPage() {
  const search = useSearch({ from: "/_chat/apps" });
  const navigate = useNavigate({ from: "/apps" });
  const { environments } = useEnvironments();
  const environment =
    environments.find((entry) => entry.environmentId === search.environmentId) ?? environments[0];
  return (
    <SidebarInset className="h-dvh min-h-0">
      <div className="flex items-center gap-3 border-b p-3">
        <h1 className="text-sm font-medium">Apps</h1>
        <label className="ml-auto text-sm">
          Environment{" "}
          <select
            className="h-8 max-w-64 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-label="Environment"
            value={environment?.environmentId ?? ""}
            onChange={(event) => {
              void navigate({ search: { environmentId: EnvironmentId.make(event.target.value) } });
            }}
          >
            {environments.map((entry) => (
              <option key={entry.environmentId} value={entry.environmentId}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {environment?.serverConfig?.standaloneApps ? (
        <EnvironmentApps
          key={environment.environmentId}
          environmentId={environment.environmentId}
          selectedId={search.appId}
        />
      ) : (
        <p className="p-6">
          {environment
            ? "Update this environment’s T3 server to use apps."
            : "Connect to an environment to open apps."}
        </p>
      )}
    </SidebarInset>
  );
}

function EnvironmentApps(props: { environmentId: EnvironmentId; selectedId: string | undefined }) {
  const navigate = useNavigate({ from: "/apps" });
  const list = useEnvironmentQuery(
    mcpAppEnvironment.apps({ environmentId: props.environmentId, input: {} }),
  );

  const save = useAtomCommand(mcpAppEnvironment.saveApp, { reportFailure: false });
  const canSave = useAtomValue(mcpAppEnvironment.saveApp.permissionAtom(props.environmentId));
  const canRemove = useAtomValue(mcpAppEnvironment.removeApp.permissionAtom(props.environmentId));
  const remove = useAtomCommand(mcpAppEnvironment.removeApp, { reportFailure: false });
  const selected = list.data?.find(
    (app) =>
      app.id ===
      (props.selectedId ??
        standaloneAppSelection(props.environmentId) ??
        (list.data?.length === 1 ? list.data[0]?.id : undefined)),
  );
  const document = useEnvironmentQuery(
    selected
      ? mcpAppEnvironment.appDocument({
          environmentId: props.environmentId,
          input: { appId: selected.id },
        })
      : null,
  );
  const opened =
    selected && document.data
      ? { id: selected.id, title: selected.title, app: document.data }
      : null;
  const [error, setError] = useState<string | null>(null);
  const pending = document.isPending;
  const [filter, setFilter] = useState("");
  const apps = list.data ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <details className="group border-b px-3 py-2 text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer select-none hover:text-foreground">
          Manage apps
        </summary>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <input
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            aria-label="Search apps"
            placeholder="Search apps"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {apps
            .filter((app) =>
              `${app.title} ${app.keywords.join(" ")}`.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((app) => (
              <Button
                key={app.id}
                variant={
                  opened?.id === app.id || props.selectedId === app.id ? "secondary" : "ghost"
                }
                disabled={pending}
                onClick={() => {
                  rememberStandaloneAppSelection(props.environmentId, app.id);
                  void navigate({ search: { environmentId: props.environmentId, appId: app.id } });
                }}
              >
                {app.title}
              </Button>
            ))}
          <label className="ml-auto cursor-pointer text-sm">
            Install app
            <input
              className="sr-only"
              type="file"
              accept=".json,application/json"
              aria-label="Install app manifest"
              disabled={pending || !canSave}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try {
                  if (file.size > 128 * 1024) {
                    setError("App manifest is too large.");
                    return;
                  }
                  const definition = decodeAppManifest(JSON.parse(await file.text()));
                  if (
                    !(await requestConfirmDialog(
                      `Install ${definition.title} on this environment?\nThis allows T3 to run ${definition.command} ${definition.args.join(" ")}. Install only apps you trust.`,
                    ))
                  )
                    return;
                  const result = await save({
                    environmentId: props.environmentId,
                    input: definition,
                  });
                  if (result._tag !== "Success") {
                    setError(String(squashAtomCommandFailure(result)));
                    return;
                  }
                  list.refresh();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not install app.");
                }
              }}
            />
          </label>
          <Button
            variant="ghost"
            onClick={() => {
              list.refresh();
              document.refresh();
            }}
          >
            Refresh
          </Button>
          {opened ? (
            <Button
              variant="ghost"
              disabled={pending || !canRemove}
              onClick={async () => {
                if (
                  !(await requestConfirmDialog(
                    `Uninstall ${opened.title}? Its data will remain with its server.`,
                  ))
                )
                  return;
                const result = await remove({
                  environmentId: props.environmentId,
                  input: { appId: opened.id },
                });
                if (result._tag !== "Success") {
                  setError(String(squashAtomCommandFailure(result)));
                  return;
                }
                rememberStandaloneAppSelection(props.environmentId, undefined);
                await navigate({ search: { environmentId: props.environmentId } });
                list.refresh();
              }}
            >
              Uninstall
            </Button>
          ) : null}
        </div>
      </details>
      {error || list.error || document.error ? (
        <p role="alert" className="p-4">
          {error ?? document.error ?? `Apps unavailable on this environment: ${list.error}`}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="p-4">
          Opening app…
        </p>
      ) : null}
      {opened ? (
        <StandaloneAppView
          key={`${opened.id}:${document.dataUpdatedAt}`}
          environmentId={props.environmentId}
          appId={opened.id}
          app={opened.app}
          title={opened.title}
        />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          {apps.length
            ? "Select an app to open it. Apps work without an AI conversation."
            : list.isPending
              ? "Loading apps…"
              : "Install an app manifest to get started."}
        </p>
      )}
    </div>
  );
}
