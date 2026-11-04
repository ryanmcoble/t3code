import { useState } from "react";
import { View, TextInput } from "react-native";
import * as Crypto from "expo-crypto";
import type { EnvironmentId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";

export function ThreadMemoryEntryEditor({
  environmentId,
  entryId,
  scopeId,
  title,
  done,
}: {
  readonly environmentId: EnvironmentId;
  readonly entryId: string;
  readonly scopeId: string;
  readonly title: string;
  readonly done: () => void;
}) {
  const state = useEnvironmentQuery(
    sharedCapabilities.memoryQuery({
      environmentId,
      input: { scopeId, query: title, tokenBudget: 8192 },
    }),
  );
  const entry = state.data?.entries.find((value) => value.id === entryId);
  const command = useAtomCommand(sharedCapabilities.memoryCommand, { reportFailure: false });
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async (forget: boolean) => {
    if (!entry || busy) return;
    setBusy(true);
    const result = await command({
      environmentId,
      input: forget
        ? { operation: "delete", scopeId, entryId }
        : {
            operation: "write",
            entry: {
              id: Crypto.randomUUID(),
              scopeId,
              supersedes: entryId,
              kind: entry.kind,
              title: entry.title,
              content: content ?? entry.content,
              source: entry.source,
              ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
              ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
            },
          },
    }).catch(() => null);
    const error = result === null || isAtomCommandInterrupted(result) || result._tag === "Failure";
    setFailed(error);
    if (!error) done();
    setBusy(false);
  };
  if (!entry)
    return (
      <Text className="px-4 text-xs text-foreground-muted">
        {state.isPending
          ? "Loading memory…"
          : "This memory changed or is unavailable. Refresh to check again."}
      </Text>
    );
  return (
    <View className="gap-2">
      <Text className="px-4 text-xs text-foreground-muted">Source: {entry.source.reference}</Text>
      <TextInput
        accessibilityLabel={`Correct ${title}`}
        value={content ?? entry.content}
        onChangeText={setContent}
        editable={!busy}
        multiline
        className="mx-4 rounded border border-border p-3 text-foreground"
      />
      <ListActionRow
        label="Save correction"
        disabled={busy || !(content ?? entry.content).trim()}
        onPress={() => void save(false)}
      />
      <ListActionRow label="Forget" disabled={busy} onPress={() => void save(true)} />
      <ListActionRow label="Close" disabled={busy} onPress={done} />
      {failed ? (
        <Text className="px-4 text-xs text-danger-foreground">
          Memory could not be updated. Check access and refresh.
        </Text>
      ) : null}
    </View>
  );
}
