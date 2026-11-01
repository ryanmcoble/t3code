import { useState } from "react";
import { DEFAULT_MEMORY_SETTINGS, type MemoryCommand, type MemoryState } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

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
    <fieldset disabled={disabled} className="space-y-3 rounded border p-3">
      <p className="text-sm font-medium">Automatic recall and learning</p>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.recallEnabled}
          onChange={(e) => setDraft({ ...draft, recallEnabled: e.target.checked })}
        />
        Search applicable categories before each prompt
      </label>
      <label className="block text-sm">
        Learning mode
        <select
          aria-label="Memory learning mode"
          value={draft.learningMode}
          onChange={(e) =>
            setDraft({ ...draft, learningMode: e.target.value as typeof draft.learningMode })
          }
          className="block w-full rounded border bg-background p-2"
        >
          <option value="manual">Manual saves only</option>
          <option value="suggest">Suggest memories for review</option>
          <option value="automatic">Save supported preferences; review other findings</option>
        </select>
      </label>
      <label className="block text-sm">
        What should T3 remember?
        <Textarea
          aria-label="Memory learning guidance"
          value={draft.guidance}
          onChange={(e) => setDraft({ ...draft, guidance: e.target.value })}
          placeholder="Remember durable workflow preferences and accepted decisions. Exclude temporary investigations."
        />
      </label>
      <label className="block text-sm">
        Maximum recalled tokens
        <Input
          aria-label="Memory context budget"
          type="number"
          min={128}
          max={8192}
          value={draft.tokenBudget}
          onChange={(e) => setDraft({ ...draft, tokenBudget: Number(e.target.value) })}
        />
      </label>
      <label className="block text-sm">
        Local Ollama extraction model
        <Input
          aria-label="Memory extraction model"
          value={draft.extractorModel}
          onChange={(e) => setDraft({ ...draft, extractorModel: e.target.value })}
          placeholder="An installed model on this environment"
        />
      </label>
      <label className="block text-sm">
        Daily extraction token limit
        <Input
          aria-label="Memory daily token limit"
          type="number"
          min={0}
          max={1000000}
          value={draft.maxDailyTokens}
          onChange={(e) => setDraft({ ...draft, maxDailyTokens: Number(e.target.value) })}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Extraction runs on this environment's local Ollama service with reasoning disabled. Each
        attempt reserves 8,704 tokens. An empty model or zero budget prevents extraction. Existing
        documentation is not imported.
      </p>
      <Button
        onClick={() =>
          void run({
            operation: "settings-save",
            expectedRevision: saved.revision,
            settings: { ...draft, revision: saved.revision + 1 },
          })
        }
      >
        Save memory behavior
      </Button>
      {state.captureUsage ? (
        <p className="text-xs text-muted-foreground">
          Extraction today: {state.captureUsage.reservedTokens} reserved tokens.{" "}
          {state.captureUsage.jobs.map((job) => `${job.count} ${job.status}`).join(" · ")}
        </p>
      ) : null}
      <Button variant="outline" onClick={refresh}>
        Refresh memory
      </Button>
      {(state.suggestions ?? []).map((suggestion) => (
        <div key={suggestion.id} className="space-y-2 rounded border p-3">
          <p className="text-sm font-medium">Review: {suggestion.entry.title}</p>
          <p className="text-sm">{suggestion.entry.content}</p>
          <p className="text-xs text-muted-foreground">{suggestion.entry.source.reference}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                void run({ operation: "suggestion-resolve", id: suggestion.id, accept: true })
              }
            >
              Remember
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void run({ operation: "suggestion-resolve", id: suggestion.id, accept: false })
              }
            >
              Reject
            </Button>
          </div>
        </div>
      ))}
      <details>
        <summary className="text-sm">Recent recall activity</summary>
        {(state.receipts ?? []).map((receipt) => (
          <div key={receipt.id} className="space-y-1 py-2 text-sm">
            <p>
              {receipt.status} · {receipt.estimatedTokens} tokens · {receipt.entries.length}{" "}
              memories
            </p>
            <p>
              {receipt.categories
                .map((category) => `${category.name}: ${category.reason}`)
                .join("; ") || "No matching category"}
            </p>
            {receipt.entries.map((entry) => (
              <p key={entry.id}>
                {entry.title} · {entry.version}
              </p>
            ))}
          </div>
        ))}
      </details>
    </fieldset>
  );
}
