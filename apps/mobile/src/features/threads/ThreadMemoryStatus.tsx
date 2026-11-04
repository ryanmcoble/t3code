import { ThreadMemoryEntryEditor } from "./ThreadMemoryEntryEditor";
import { useState } from "react";
import { View, Pressable } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadMemoryStatus({
  environmentId,
  threadId,
  activityKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activityKey: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(sharedCapabilities.memoryCommand.permissionAtom(environmentId));
  const supported = config?.environment.capabilities.memoryLifecycle === 1;
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const state = useEnvironmentQuery(
    supported && allowed
      ? sharedCapabilities.memoryStatus({ environmentId, input: { threadId, activityKey } })
      : null,
  );
  const command = useAtomCommand(sharedCapabilities.memoryCommand, { reportFailure: false });
  if (!supported || !allowed) return null;
  const receipt = state.data?.receipt;
  const policy = state.data?.policy ?? { threadId, recall: true, learn: true };
  const disabled = busy || state.isPending || !state.data;
  const change = async (field: "recall" | "learn", value: boolean) => {
    if (disabled) return;
    setBusy(true);
    const result = await command({
      environmentId,
      input: { operation: "thread-policy-save", policy: { ...policy, [field]: value } },
    }).catch(() => null);
    setFailed(result === null || isAtomCommandInterrupted(result) || result._tag === "Failure");
    state.refresh();
    setBusy(false);
  };
  return (
    <View className="border-b border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Memory controls"
        onPress={() => setExpanded(!expanded)}
        className="px-4 py-2"
      >
        <Text className="text-xs text-foreground-muted">
          {receipt
            ? `Memory: ${receipt.status} · ${receipt.entries.length} entries · ${receipt.estimatedTokens} tokens`
            : "Memory controls"}
        </Text>
      </Pressable>
      {expanded ? (
        <View>
          <ListToggleRow
            disabled={disabled}
            label="Use memory in this thread"
            value={policy.recall}
            onValueChange={(value) => void change("recall", value)}
          />
          <ListToggleRow
            disabled={disabled}
            label="Allow learning from this thread"
            value={policy.learn}
            onValueChange={(value) => void change("learn", value)}
          />
          {receipt?.categories.map((category) => (
            <Text key={category.id} className="px-4 text-xs text-foreground-muted">
              {category.name} · {category.reason}
            </Text>
          ))}
          {receipt?.entries.map((entry) => (
            <View key={entry.id}>
              <ListActionRow
                label={`${entry.title} · ${entry.version}`}
                onPress={() => setEditing(editing === entry.id ? null : entry.id)}
              />
              {editing === entry.id ? (
                <ThreadMemoryEntryEditor
                  key={entry.id}
                  environmentId={environmentId}
                  entryId={entry.id}
                  scopeId={entry.scopeId}
                  title={entry.title}
                  done={() => {
                    setEditing(null);
                    state.refresh();
                  }}
                />
              ) : null}
            </View>
          ))}
          {failed || state.error ? (
            <Text className="px-4 text-xs text-danger-foreground">
              Memory controls could not be updated.
            </Text>
          ) : null}
          <ListActionRow label="Refresh memory activity" onPress={() => state.refresh()} />
        </View>
      ) : null}
    </View>
  );
}
