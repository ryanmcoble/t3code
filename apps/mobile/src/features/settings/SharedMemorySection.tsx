import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MemoryEntry,
  type MemoryScope,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Share, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
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

export function SharedMemorySection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(sharedCapabilities.memoryCommand.permissionAtom(environmentId));
  const supported = config?.environment.capabilities.sharedMemory === 1;
  const state = useEnvironmentQuery(
    supported && allowed ? sharedCapabilities.memoryState({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(sharedCapabilities.memoryCommand, { reportFailure: false });
  const enroll = useAtomCommand(sharedCapabilities.enroll, { reportFailure: false });
  const exportScope = useAtomCommand(sharedCapabilities.memoryExport, { reportFailure: false });
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [selected, setSelected] = useState("");
  const scopes = state.data?.scopes ?? [];
  const bindings = state.data?.bindings ?? [];
  const scopeId = selected || scopes[0]?.id || bindings[0]?.scopeId || "";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const notes = useEnvironmentQuery(
    supported && allowed && scopeId
      ? sharedCapabilities.memoryQuery({
          environmentId,
          input: { scopeId, query: search, tokenBudget: 8192 },
        })
      : null,
  );
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [reference, setReference] = useState("");
  const [entryId, setEntryId] = useState(Crypto.randomUUID);
  const [correction, setCorrection] = useState<MemoryEntry | null>(null);
  const [scopeName, setScopeName] = useState("");
  const [scopeKind, setScopeKind] = useState<MemoryScope["kind"]>("project");
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>([]);
  const [editingScope, setEditingScope] = useState<MemoryScope | null>(null);
  const [writes, setWrites] = useState(true);
  const [selectedProviders, setSelectedProviders] = useState<ReadonlyArray<string> | null>(null);
  const providerIds =
    config?.providers
      .filter((p) => (selectedProviders ? selectedProviders.includes(p.instanceId) : p.enabled))
      .map((p) => p.instanceId) ?? [];
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { environments } = useEnvironments();
  const owners = environments.filter(
    (e) =>
      e.environmentId !== environmentId &&
      e.serverConfig?.environment.capabilities.sharedMemory === 1,
  );
  const [owner, setOwner] = useState<EnvironmentId | null>(null);
  const ownerId = owner ?? owners[0]?.environmentId ?? environmentId;
  const ownerCanGrant = useAtomValue(sharedCapabilities.memoryGrant.permissionAtom(environmentId));
  const revokeGrant = useAtomCommand(sharedCapabilities.memoryGrant, { reportFailure: false });
  const canGrant = useAtomValue(sharedCapabilities.memoryGrant.permissionAtom(ownerId));
  const source = useEnvironmentQuery(
    ownerId !== environmentId
      ? sharedCapabilities.memoryState({ environmentId: ownerId, input: {} })
      : null,
  );
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    setBusy(true);
    setError(null);
    return await (async () => {
      const value = await command({ environmentId, input });
      if (isAtomCommandInterrupted(value) || value._tag === "Failure") {
        setError("Memory could not be changed. Check access and refresh.");
        return false;
      }
      state.refresh();
      notes.refresh();
      return true;
    })().finally(() => {
      setBusy(false);
    });
  };
  if (!supported) return null;
  return (
    <SettingsSection title="Shared memory">
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground-muted">
          Source-attributed project knowledge shared across harnesses. Access stays explicit for
          personal, company and project scopes.
        </Text>
        {error || state.error || notes.error ? (
          <Text className="text-sm text-danger-foreground">
            {error ?? state.error ?? notes.error}
          </Text>
        ) : null}
      </View>
      {[
        ...scopes.map((s) => ({ id: s.id, name: s.name })),
        ...bindings.map((b) => ({ id: b.scopeId, name: `${b.name} · shared` })),
      ].map((s) => (
        <ListChoiceRow
          key={s.id}
          label={s.name}
          selected={scopeId === s.id}
          onPress={() => {
            setSelected(s.id);
            setCorrection(null);
          }}
        />
      ))}
      {scopeId ? (
        <>
          <View className="gap-2 p-4">
            <TextInput
              accessibilityLabel="Search memory"
              placeholder="Search decisions and findings"
              value={query}
              onChangeText={setQuery}
              className="rounded-lg border border-border p-3 text-foreground"
            />
          </View>
          <ListActionRow
            label="Search memory"
            onPress={() => {
              setSearch(query);
              notes.refresh();
            }}
          />
          {notes.data?.entries.map((entry) => (
            <View key={entry.id} className="gap-2 border-t border-border p-4">
              <Text className="text-base font-t3-medium text-foreground">{entry.title}</Text>
              <Text className="text-sm text-foreground">{entry.content}</Text>
              <Text className="text-xs text-foreground-muted">
                {entry.source.reference} · {entry.author.providerInstanceId ?? "You"} ·{" "}
                {entry.createdAt}
              </Text>
              <ListActionRow
                label="Correct this finding"
                disabled={!allowed || busy}
                onPress={() => {
                  setCorrection(entry);
                  setEntryId(Crypto.randomUUID());
                  setTitle(entry.title);
                  setContent(entry.content);
                  setReference(entry.source.reference);
                }}
              />
              {scopes.some((s) => s.id === scopeId) ? (
                <ListActionRow
                  label="Delete this finding"
                  tone="danger"
                  disabled={!allowed || busy}
                  onPress={() =>
                    Alert.alert("Delete finding?", "This removes its content from shared memory.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () =>
                          void run({ operation: "delete", scopeId, entryId: entry.id }),
                      },
                    ])
                  }
                />
              ) : null}
            </View>
          ))}
          <View className="gap-2 p-4">
            <Text className="text-sm font-t3-medium text-foreground">
              {correction ? "Correct finding" : "Add finding"}
            </Text>
            <TextInput
              accessibilityLabel="Memory title"
              placeholder="Title"
              value={title}
              onChangeText={setTitle}
              className="rounded-lg border border-border p-3 text-foreground"
            />
            <TextInput
              accessibilityLabel="Memory content"
              placeholder="Decision, preference or finding"
              multiline
              value={content}
              onChangeText={setContent}
              className="rounded-lg border border-border p-3 text-foreground"
            />
            <TextInput
              accessibilityLabel="Memory source"
              placeholder="Source or reason for correction"
              value={reference}
              onChangeText={setReference}
              className="rounded-lg border border-border p-3 text-foreground"
            />
          </View>
          <ListActionRow
            label={correction ? "Save correction" : "Save finding"}
            disabled={!allowed || busy || !title || !content || !reference}
            onPress={async () => {
              if (
                await run({
                  operation: "write",
                  entry: {
                    id: entryId,
                    scopeId,
                    title,
                    content,
                    source: { reference },
                    kind: correction?.kind ?? "finding",
                    ...(correction ? { supersedes: correction.id } : {}),
                  },
                })
              ) {
                setCorrection(null);
                setEntryId(Crypto.randomUUID());
                setTitle("");
                setContent("");
                setReference("");
              }
            }}
          />
        </>
      ) : null}
      <ListActionRow
        label={expanded ? "Hide memory setup" : "Manage memory scopes and connections"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <>
          {state.data?.grants
            .filter((grant) => grant.scopeId === scopeId)
            .map((grant) => (
              <ListActionRow
                key={grant.destinationEnvironmentId}
                label={`Revoke memory access: ${environments.find((e) => e.environmentId === grant.destinationEnvironmentId)?.label ?? grant.destinationEnvironmentId}`}
                disabled={!ownerCanGrant || busy}
                onPress={async () => {
                  const result = await revokeGrant({
                    environmentId,
                    input: { ...grant, revoke: true },
                  });
                  if (isAtomCommandInterrupted(result) || result._tag === "Failure")
                    setError("Memory access could not be revoked.");
                  else state.refresh();
                }}
              />
            ))}
          {scopes.map((s) => (
            <ListActionRow
              key={s.id}
              label={`Edit access for ${s.name}`}
              onPress={() => {
                setEditingScope(s);
                setScopeName(s.name);
                setScopeKind(s.kind);
                setProjectIds(s.projectIds);
                setSelectedProviders(s.providerInstanceIds);
                setWrites(s.writableProviderInstanceIds.length > 0);
              }}
            />
          ))}
          <View className="p-4">
            <TextInput
              accessibilityLabel="Scope name"
              placeholder="New scope name"
              value={scopeName}
              onChangeText={setScopeName}
              className="rounded-lg border border-border p-3 text-foreground"
            />
          </View>
          {(["project", "personal", "company"] as const).map((kind) => (
            <ListChoiceRow
              key={kind}
              label={`${kind} memory`}
              selected={scopeKind === kind}
              onPress={() => setScopeKind(kind)}
            />
          ))}
          {projects.map((p) => (
            <ListToggleRow
              key={p.id}
              label={p.title}
              value={projectIds.includes(p.id)}
              onValueChange={(on) =>
                setProjectIds(on ? [...projectIds, p.id] : projectIds.filter((id) => id !== p.id))
              }
            />
          ))}
          {config?.providers.map((p) => (
            <ListToggleRow
              key={p.instanceId}
              label={p.displayName ?? p.instanceId}
              value={providerIds.includes(p.instanceId)}
              onValueChange={(on) =>
                setSelectedProviders(
                  on
                    ? [...providerIds, p.instanceId]
                    : providerIds.filter((id) => id !== p.instanceId),
                )
              }
            />
          ))}
          <ListToggleRow
            label="Allow selected harnesses to write"
            value={writes}
            onValueChange={setWrites}
          />
          <ListActionRow
            label={editingScope ? "Update scope access" : "Create memory scope"}
            disabled={!allowed || busy || !scopeName}
            onPress={async () => {
              if (
                await run({
                  operation: "scope-save",
                  expectedRevision: editingScope?.revision ?? 0,
                  scope: {
                    id: editingScope?.id ?? Crypto.randomUUID(),
                    name: scopeName,
                    kind: scopeKind,
                    projectIds,
                    providerInstanceIds: providerIds,
                    writableProviderInstanceIds: writes ? providerIds : [],
                    revision: (editingScope?.revision ?? 0) + 1,
                    createdAt: editingScope?.createdAt ?? new Date().toISOString(),
                  },
                })
              ) {
                setScopeName("");
                setEditingScope(null);
              }
            }}
          />
          {state.data?.profileScopes.map((scope) => (
            <ListActionRow
              key={scope.scopeId}
              label={`Profile memory: ${scope.name}`}
              onPress={() => {
                setOwner(scope.ownerEnvironmentId);
                setWrites(scope.access === "write");
              }}
            />
          ))}
          {owners.map((o) => (
            <ListChoiceRow
              key={o.environmentId}
              label={`Memory owner: ${o.label}`}
              selected={ownerId === o.environmentId}
              onPress={() => setOwner(o.environmentId)}
            />
          ))}
          {source.data?.scopes.map((s) => (
            <ListActionRow
              key={s.id}
              label={`Connect ${s.name}`}
              description="Uses the projects and harnesses selected above."
              disabled={!allowed || !canGrant || busy || !projectIds.length || !providerIds.length}
              onPress={async () => {
                const route = linkableMachines({
                  environments,
                  threadEnvironmentId: environmentId,
                  links: [],
                  connect: new Map(),
                })
                  .find((e) => e.environmentId === ownerId)
                  ?.urls.find((url) => url.startsWith("https://"));
                if (!route) {
                  setError("The memory owner needs a reachable HTTPS route.");
                  return;
                }
                const value = await enroll({
                  ownerId,
                  destinationId: environmentId,
                  binding: {
                    scopeId: s.id,
                    name: s.name,
                    ownerEnvironmentId: ownerId,
                    sourceUrl: route,
                    projectIds,
                    providerInstanceIds: providerIds,
                    access: writes ? "write" : "read",
                  },
                });
                if (isAtomCommandInterrupted(value) || value._tag === "Failure")
                  setError("Memory enrollment failed.");
                else state.refresh();
              }}
            />
          ))}
          {bindings.map((b) => (
            <ListActionRow
              key={b.scopeId}
              label={`Disconnect ${b.name}`}
              onPress={() => void run({ operation: "disconnect", scopeId: b.scopeId })}
            />
          ))}
          {scopes.find((s) => s.id === scopeId) ? (
            <>
              <ListActionRow
                label="Export scope and history"
                disabled={!allowed || busy}
                onPress={async () => {
                  const value = await exportScope({ environmentId, input: { scopeId } });
                  if (!isAtomCommandInterrupted(value) && value._tag === "Success")
                    await Share.share({
                      message: JSON.stringify(value.value, null, 2),
                      title: "Shared memory export",
                    });
                }}
              />
              <ListActionRow
                label="Delete scope and history"
                tone="danger"
                disabled={!allowed || busy}
                onPress={() => {
                  const scope = scopes.find((s) => s.id === scopeId)!;
                  Alert.alert(
                    `Delete ${scope.name}?`,
                    "All findings and history in this scope will be removed.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () =>
                          void run({
                            operation: "scope-delete",
                            scopeId,
                            expectedRevision: scope.revision,
                          }),
                      },
                    ],
                  );
                }}
              />
            </>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
