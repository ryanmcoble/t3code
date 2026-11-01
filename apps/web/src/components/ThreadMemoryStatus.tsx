import { ThreadMemoryEntryEditor } from "./ThreadMemoryEntryEditor";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { serverEnvironment } from "~/state/server";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";

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
  const status = useEnvironmentQuery(
    supported && allowed
      ? sharedCapabilities.memoryStatus({ environmentId, input: { threadId, activityKey } })
      : null,
  );
  const command = useAtomCommand(sharedCapabilities.memoryCommand, { reportFailure: false });
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  if (!supported || !allowed) return null;
  const receipt = status.data?.receipt;
  const policy = status.data?.policy ?? { threadId, recall: true, learn: true };
  const disabled = busy || status.isPending || !status.data;
  const change = async (field: "recall" | "learn", value: boolean) => {
    if (disabled) return;
    setBusy(true);
    const result = await command({
      environmentId,
      input: { operation: "thread-policy-save", policy: { ...policy, [field]: value } },
    }).catch(() => null);
    setError(result === null || isAtomCommandInterrupted(result) || result._tag === "Failure");
    status.refresh();
    setBusy(false);
  };
  return (
    <details className="border-b px-4 py-1 text-xs text-muted-foreground">
      <summary>
        {receipt
          ? `Memory: ${receipt.status} · ${receipt.entries.length} entries · ${receipt.estimatedTokens} tokens`
          : "Memory controls"}
      </summary>
      <div className="space-y-2 py-2">
        <label className="flex gap-2">
          <input
            type="checkbox"
            disabled={disabled}
            checked={policy.recall}
            onChange={(event) => void change("recall", event.target.checked)}
          />
          Use memory in this thread
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            disabled={disabled}
            checked={policy.learn}
            onChange={(event) => void change("learn", event.target.checked)}
          />
          Allow learning from this thread
        </label>
        {receipt?.categories.map((category) => (
          <p key={category.id}>
            {category.name} · {category.reason}
          </p>
        ))}
        {receipt?.entries.map((entry) => (
          <div key={entry.id} className="space-y-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(editing === entry.id ? null : entry.id)}
            >
              {entry.title} · {entry.version}
            </Button>
            {editing === entry.id ? (
              <ThreadMemoryEntryEditor
                key={entry.id}
                environmentId={environmentId}
                entryId={entry.id}
                scopeId={entry.scopeId}
                title={entry.title}
                done={() => {
                  setEditing(null);
                  status.refresh();
                }}
              />
            ) : null}
          </div>
        ))}
        {error || status.error ? (
          <p role="alert">Memory controls could not be updated. Refresh and try again.</p>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => status.refresh()}>
          Refresh memory activity
        </Button>
      </div>
    </details>
  );
}
