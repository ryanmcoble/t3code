import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { sharedCapabilities } from "~/state/sharedCapabilities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

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
              id: randomUUID(),
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
      <p>
        {state.isPending
          ? "Loading memory…"
          : "This memory changed or is unavailable. Refresh to check again."}
      </p>
    );
  return (
    <div className="space-y-2 rounded border p-2">
      <p>Source: {entry.source.reference}</p>
      <Textarea
        aria-label={`Correct ${title}`}
        value={content ?? entry.content}
        onChange={(event) => setContent(event.target.value)}
        disabled={busy}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !(content ?? entry.content).trim()}
          onClick={() => void save(false)}
        >
          Save correction
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void save(true)}>
          Forget
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={done}>
          Close
        </Button>
      </div>
      {failed ? <p role="alert">Memory could not be updated. Check access and refresh.</p> : null}
    </div>
  );
}
