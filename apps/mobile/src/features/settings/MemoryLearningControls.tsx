import { useState } from "react";
import { TextInput, View } from "react-native";
import { DEFAULT_MEMORY_SETTINGS, type MemoryCommand, type MemoryState } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";

export function MemoryLearningControls({
  state,
  disabled,
  run,
  refresh,
}: {
  readonly state: typeof MemoryState.Type;
  readonly disabled: boolean;
  readonly refresh: () => void;
  readonly run: (command: typeof MemoryCommand.Type) => Promise<boolean>;
}) {
  const saved = state.settings ?? DEFAULT_MEMORY_SETTINGS;
  const [draft, setDraft] = useState(saved);
  return (
    <View>
      <ListToggleRow
        label="Recall memories before each prompt"
        value={draft.recallEnabled}
        onValueChange={(value) => setDraft({ ...draft, recallEnabled: value })}
        disabled={disabled}
      />
      {(["manual", "suggest", "automatic"] as const).map((mode) => (
        <ListChoiceRow
          key={mode}
          label={
            mode === "manual"
              ? "Manual saves only"
              : mode === "suggest"
                ? "Suggest memories for review"
                : "Save preferences; review other findings"
          }
          selected={draft.learningMode === mode}
          onPress={() => setDraft({ ...draft, learningMode: mode })}
          disabled={disabled}
        />
      ))}
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground">Learning guidance</Text>
        <TextInput
          accessibilityLabel="Memory learning guidance"
          multiline
          value={draft.guidance}
          onChangeText={(guidance) => setDraft({ ...draft, guidance })}
          editable={!disabled}
          className="rounded-lg border border-border p-3 text-foreground"
        />
        <Text className="text-sm text-foreground">Maximum recalled tokens</Text>
        <TextInput
          accessibilityLabel="Memory context budget"
          keyboardType="number-pad"
          value={String(draft.tokenBudget)}
          onChangeText={(value) => setDraft({ ...draft, tokenBudget: Number(value) })}
          editable={!disabled}
          className="rounded-lg border border-border p-3 text-foreground"
        />
        <Text className="text-sm text-foreground">Local Ollama extraction model</Text>
        <TextInput
          accessibilityLabel="Memory extraction model"
          autoCapitalize="none"
          value={draft.extractorModel}
          onChangeText={(extractorModel) => setDraft({ ...draft, extractorModel })}
          editable={!disabled}
          className="rounded-lg border border-border p-3 text-foreground"
        />
        <Text className="text-sm text-foreground">Daily extraction token limit</Text>
        <TextInput
          accessibilityLabel="Memory daily token limit"
          keyboardType="number-pad"
          value={String(draft.maxDailyTokens)}
          onChangeText={(value) => setDraft({ ...draft, maxDailyTokens: Number(value) })}
          editable={!disabled}
          className="rounded-lg border border-border p-3 text-foreground"
        />
        <Text className="text-xs text-foreground-muted">
          Extraction uses this environment's local Ollama service, with reasoning disabled. Each
          attempt reserves 8,704 tokens. An empty model or zero budget prevents extraction. Baseline
          documentation import is deferred.
        </Text>
      </View>
      <ListActionRow
        label="Save memory behavior"
        disabled={disabled}
        onPress={() =>
          void run({
            operation: "settings-save",
            expectedRevision: saved.revision,
            settings: { ...draft, revision: saved.revision + 1 },
          })
        }
      />
      {state.captureUsage ? (
        <Text className="px-4 text-xs text-foreground-muted">
          Extraction today: {state.captureUsage.reservedTokens} reserved tokens.{" "}
          {state.captureUsage.jobs.map((job) => `${job.count} ${job.status}`).join(" · ")}
        </Text>
      ) : null}
      <ListActionRow label="Refresh memory" onPress={refresh} />
      {(state.suggestions ?? []).map((suggestion) => (
        <View key={suggestion.id} className="gap-2 border-t border-border p-4">
          <Text className="text-base font-t3-medium text-foreground">
            Review: {suggestion.entry.title}
          </Text>
          <Text className="text-sm text-foreground">{suggestion.entry.content}</Text>
          <Text className="text-xs text-foreground-muted">{suggestion.entry.source.reference}</Text>
          <ListActionRow
            label="Remember this finding"
            disabled={disabled}
            onPress={() =>
              void run({ operation: "suggestion-resolve", id: suggestion.id, accept: true })
            }
          />
          <ListActionRow
            label="Reject suggestion"
            disabled={disabled}
            onPress={() =>
              void run({ operation: "suggestion-resolve", id: suggestion.id, accept: false })
            }
          />
        </View>
      ))}
      {(state.receipts ?? []).slice(0, 10).map((receipt) => (
        <View key={receipt.id} className="gap-1 border-t border-border p-4">
          <Text className="text-sm text-foreground">
            {receipt.status} · {receipt.entries.length} memories · {receipt.estimatedTokens} tokens
          </Text>
          <Text className="text-xs text-foreground-muted">
            {receipt.categories
              .map((category) => `${category.name}: ${category.reason}`)
              .join("; ") || "No matching categories"}
          </Text>
          {receipt.entries.map((entry) => (
            <Text key={entry.id} className="text-xs text-foreground-muted">
              {entry.title} · {entry.version}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}
