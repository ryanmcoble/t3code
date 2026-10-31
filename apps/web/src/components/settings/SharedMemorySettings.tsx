import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MemoryEntry,
  type MemoryScope,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

export function SharedMemorySettings({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(sharedCapabilities.memoryCommand.permissionAtom(environmentId));
  const supported = config?.environment.capabilities.sharedMemory === 1;
  const state = useEnvironmentQuery(
    supported && allowed ? sharedCapabilities.memoryState({ environmentId, input: {} }) : null,
  );
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const { environments } = useEnvironments();
  const owners = environments.filter(
    (e) =>
      e.environmentId !== environmentId &&
      e.serverConfig?.environment.capabilities.sharedMemory === 1,
  );
  const [ownerId, setOwnerId] = useState<EnvironmentId | null>(null);
  const sourceId = ownerId ?? owners[0]?.environmentId ?? environmentId;
  const source = useEnvironmentQuery(
    sourceId !== environmentId
      ? sharedCapabilities.memoryState({ environmentId: sourceId, input: {} })
      : null,
  );
  const ownerCanGrant = useAtomValue(sharedCapabilities.memoryGrant.permissionAtom(environmentId));
  const revokeGrant = useAtomCommand(sharedCapabilities.memoryGrant, { reportFailure: false });
  const canGrant = useAtomValue(sharedCapabilities.memoryGrant.permissionAtom(sourceId));
  const command = useAtomCommand(sharedCapabilities.memoryCommand, { reportFailure: false });
  const enroll = useAtomCommand(sharedCapabilities.enroll, { reportFailure: false });
  const exportScope = useAtomCommand(sharedCapabilities.memoryExport, { reportFailure: false });
  const [selected, setSelected] = useState("");
  const scopes = state.data?.scopes ?? [];
  const bindings = state.data?.bindings ?? [];
  const selectedId = selected || scopes[0]?.id || bindings[0]?.scopeId || "";
  const [queryText, setQueryText] = useState("");
  const [search, setSearch] = useState("");
  const results = useEnvironmentQuery(
    supported && allowed && selectedId
      ? sharedCapabilities.memoryQuery({
          environmentId,
          input: { scopeId: selectedId, query: search, tokenBudget: 8192 },
        })
      : null,
  );
  const [editing, setEditing] = useState<MemoryScope | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MemoryScope["kind"]>("project");
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>([]);
  const [providerIds, setProviderIds] = useState<ReadonlyArray<ProviderInstanceId> | null>(null);
  const chosenProviders =
    providerIds ?? config?.providers.filter((p) => p.enabled).map((p) => p.instanceId) ?? [];
  const [canWrite, setCanWrite] = useState(true);
  const [correction, setCorrection] = useState<MemoryEntry | null>(null);
  const [entryId, setEntryId] = useState(randomUUID);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    setBusy(true);
    setError(null);
    try {
      const value = await command({ environmentId, input });
      if (isAtomCommandInterrupted(value) || value._tag === "Failure") {
        setError("Memory could not be updated. Check scope access and refresh.");
        return false;
      }
      state.refresh();
      results.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };
  if (!supported) return null;
  return (
    <SettingsSection title={`Shared memory · ${label}`}>
      <div className="space-y-4 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Keep decisions, preferences and verified findings in one place across harnesses. Each
          scope has explicit project and provider access. Retrieved notes are evidence.
        </p>
        {!allowed ? <p>Managing memory requires settings access on this environment.</p> : null}
        {error || state.error || results.error ? (
          <p role="alert">{error ?? state.error ?? results.error}</p>
        ) : null}
        {state.data?.grants
          .filter((grant) => grant.scopeId === selectedId)
          .map((grant) => (
            <div
              key={grant.destinationEnvironmentId}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span>
                {environments.find((e) => e.environmentId === grant.destinationEnvironmentId)
                  ?.label ?? grant.destinationEnvironmentId}{" "}
                · {grant.access}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!ownerCanGrant || busy}
                onClick={async () => {
                  const result = await revokeGrant({
                    environmentId,
                    input: { ...grant, revoke: true },
                  });
                  if (isAtomCommandInterrupted(result) || result._tag === "Failure")
                    setError("Memory access could not be revoked.");
                  else state.refresh();
                }}
              >
                Revoke memory access
              </Button>
            </div>
          ))}
        <fieldset disabled={!allowed || busy} className="space-y-3">
          <label className="block text-sm">
            Memory scope
            <select
              aria-label="Memory scope"
              value={selectedId}
              onChange={(e) => {
                setSelected(e.target.value);
                setCorrection(null);
              }}
              className="w-full rounded border bg-background p-2"
            >
              <option value="">Choose a scope</option>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.kind}
                </option>
              ))}
              {bindings.map((s) => (
                <option key={s.scopeId} value={s.scopeId}>
                  {s.name} · shared
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Input
              aria-label="Search memory"
              placeholder="Find a decision or finding"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => {
                setSearch(queryText);
                results.refresh();
              }}
            >
              Search
            </Button>
          </div>
          {results.data ? (
            <p className="text-xs text-muted-foreground">
              {results.data.estimatedTokens} estimated tokens
              {results.data.truncated ? " · more results exceed this context budget" : ""}
            </p>
          ) : null}
          {results.data?.entries.map((entry) => (
            <div className="space-y-2 rounded border p-3" key={entry.id}>
              <p className="font-medium">{entry.title}</p>
              <p className="whitespace-pre-wrap text-sm">{entry.content}</p>
              <p className="text-xs text-muted-foreground">
                {entry.source.reference} · {entry.author.providerInstanceId ?? "You"} ·{" "}
                {entry.createdAt}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCorrection(entry);
                    setEntryId(randomUUID());
                    setTitle(entry.title);
                    setContent(entry.content);
                    setReference(entry.source.reference);
                  }}
                >
                  Correct
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!scopes.some((s) => s.id === selectedId)}
                  onClick={() =>
                    void run({ operation: "delete", scopeId: selectedId, entryId: entry.id })
                  }
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
          {selectedId ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {correction ? `Correct “${correction.title}”` : "Add a finding"}
              </p>
              <Input
                aria-label="Memory title"
                placeholder="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Textarea
                aria-label="Memory content"
                placeholder="Decision, preference or verified finding"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
              <Input
                aria-label="Memory source"
                placeholder="Source, artifact or reason for this correction"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              <Button
                disabled={!title || !content || !reference}
                onClick={async () => {
                  if (
                    await run({
                      operation: "write",
                      entry: {
                        scopeId: selectedId,
                        id: entryId,
                        kind: correction?.kind ?? "finding",
                        title,
                        content,
                        source: { reference },
                        ...(correction ? { supersedes: correction.id } : {}),
                      },
                    })
                  ) {
                    setCorrection(null);
                    setEntryId(randomUUID());
                    setTitle("");
                    setContent("");
                    setReference("");
                  }
                }}
              >
                Save {correction ? "correction" : "finding"}
              </Button>
            </div>
          ) : null}
          <details>
            <summary>Create a scope or change access</summary>
            <div className="space-y-3 py-3">
              {scopes.map((s) => (
                <Button
                  key={s.id}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(s);
                    setName(s.name);
                    setKind(s.kind);
                    setProjectIds(s.projectIds);
                    setProviderIds(s.providerInstanceIds);
                    setCanWrite(s.writableProviderInstanceIds.length > 0);
                  }}
                >
                  Edit {s.name}
                </Button>
              ))}
              <Input
                aria-label="Scope name"
                placeholder="Scope name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <select
                aria-label="Scope kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as MemoryScope["kind"])}
                className="rounded border bg-background p-2"
              >
                <option value="project">Project</option>
                <option value="personal">Personal</option>
                <option value="company">Company</option>
              </select>
              <p className="text-sm">Allow these projects</p>
              {projects.map((p) => (
                <label key={p.id} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={projectIds.includes(p.id)}
                    onChange={(e) =>
                      setProjectIds(
                        e.target.checked
                          ? [...projectIds, p.id]
                          : projectIds.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {p.title}
                </label>
              ))}
              <p className="text-sm">Allow these harness instances</p>
              {config?.providers.map((p) => (
                <label key={p.instanceId} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={chosenProviders.includes(p.instanceId)}
                    onChange={(e) =>
                      setProviderIds(
                        e.target.checked
                          ? [...chosenProviders, p.instanceId]
                          : chosenProviders.filter((id) => id !== p.instanceId),
                      )
                    }
                  />
                  {p.displayName ?? p.instanceId}
                </label>
              ))}
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={canWrite}
                  onChange={(e) => setCanWrite(e.target.checked)}
                />
                Allow selected harnesses to add and correct findings
              </label>
              <Button
                disabled={!name}
                onClick={async () => {
                  if (
                    await run({
                      operation: "scope-save",
                      expectedRevision: editing?.revision ?? 0,
                      scope: {
                        id: editing?.id ?? randomUUID(),
                        name,
                        kind,
                        projectIds,
                        providerInstanceIds: chosenProviders,
                        writableProviderInstanceIds: canWrite ? chosenProviders : [],
                        revision: (editing?.revision ?? 0) + 1,
                        createdAt: editing?.createdAt ?? new Date().toISOString(),
                      },
                    })
                  ) {
                    setEditing(null);
                    setName("");
                  }
                }}
              >
                Save scope
              </Button>
              {editing ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(null);
                    setName("");
                  }}
                >
                  New scope instead
                </Button>
              ) : null}
            </div>
          </details>
          <details>
            <summary>Connect memory from another environment</summary>
            <div className="space-y-3 py-3">
              <select
                aria-label="Memory owner"
                value={sourceId}
                onChange={(e) => setOwnerId(e.target.value as EnvironmentId)}
                className="rounded border bg-background p-2"
              >
                {owners.map((o) => (
                  <option key={o.environmentId} value={o.environmentId}>
                    {o.label}
                  </option>
                ))}
              </select>
              {state.data?.profileScopes.map((scope) => (
                <Button
                  key={scope.scopeId}
                  variant="outline"
                  onClick={() => {
                    setOwnerId(scope.ownerEnvironmentId);
                    setCanWrite(scope.access === "write");
                  }}
                >
                  Profile memory: {scope.name}
                </Button>
              ))}
              <p className="text-sm">
                Select the local projects and harnesses above, then connect a scope. The owner keeps
                the content and corrections.
              </p>
              {source.data?.scopes.map((s) => (
                <Button
                  key={s.id}
                  variant="outline"
                  disabled={!canGrant || !projectIds.length || !chosenProviders.length}
                  onClick={async () => {
                    const route = linkableMachines({
                      environments,
                      threadEnvironmentId: environmentId,
                      links: [],
                      connect: new Map(),
                    })
                      .find((e) => e.environmentId === sourceId)
                      ?.urls.find((u) => u.startsWith("https://"));
                    if (!route) {
                      setError("The memory owner needs a reachable HTTPS route.");
                      return;
                    }
                    const result = await enroll({
                      ownerId: sourceId,
                      destinationId: environmentId,
                      binding: {
                        scopeId: s.id,
                        name: s.name,
                        ownerEnvironmentId: sourceId,
                        sourceUrl: route,
                        projectIds,
                        providerInstanceIds: chosenProviders,
                        access: canWrite ? "write" : "read",
                      },
                    });
                    if (isAtomCommandInterrupted(result) || result._tag === "Failure")
                      setError("Memory enrollment failed. Check access and connectivity.");
                    else state.refresh();
                  }}
                >
                  Connect {s.name}
                </Button>
              ))}
              {bindings.map((b) => (
                <Button
                  key={b.scopeId}
                  variant="outline"
                  onClick={() => void run({ operation: "disconnect", scopeId: b.scopeId })}
                >
                  Disconnect {b.name}
                </Button>
              ))}
            </div>
          </details>
          {scopes.find((s) => s.id === selectedId) ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  const value = await exportScope({
                    environmentId,
                    input: { scopeId: selectedId },
                  });
                  if (!isAtomCommandInterrupted(value) && value._tag === "Success") {
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(value.value, null, 2)], {
                        type: "application/json",
                      }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = "memory-scope.json";
                    link.click();
                    URL.revokeObjectURL(url);
                  }
                }}
              >
                Export scope
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const scope = scopes.find((s) => s.id === selectedId)!;
                  if (window.confirm(`Delete “${scope.name}” and its full memory history?`))
                    void run({
                      operation: "scope-delete",
                      scopeId: scope.id,
                      expectedRevision: scope.revision,
                    });
                }}
              >
                Delete scope and history
              </Button>
            </div>
          ) : null}
        </fieldset>
      </div>
    </SettingsSection>
  );
}
