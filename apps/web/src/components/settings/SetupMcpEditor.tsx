import { SetupMcpConnection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SetupMcpConnection)));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SetupMcpConnection)));

export function SetupMcpEditor({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  let entries: ReadonlyArray<SetupMcpConnection> = [];
  try {
    entries = decode(value);
  } catch {
    /* The advanced editor reports its validation error on save. */
  }
  return (
    <div className="space-y-3">
      {entries.map((c) => (
        <div key={c.name} className="flex items-center justify-between gap-2 text-sm">
          <span>
            {c.name} · {c.transport} · {c.enabled ? "enabled" : "disabled"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(encode(entries.filter((entry) => entry.name !== c.name)))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="space-y-2 rounded-lg border p-3">
        <p className="text-sm font-medium">Add MCP connection</p>
        <label className="block text-sm">
          Connection name
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="singlecomm" />
        </label>
        <label className="block text-sm">
          Transport
          <select
            className="ml-2 rounded border bg-background p-2"
            value={transport}
            onChange={(e) => setTransport(e.target.value === "http" ? "http" : "stdio")}
          >
            <option value="stdio">Local command</option>
            <option value="http">HTTP server</option>
          </select>
        </label>
        {transport === "stdio" ? (
          <>
            <label className="block text-sm">
              Executable
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="sc"
              />
            </label>
            <label className="block text-sm">
              Arguments, one per line
              <Textarea
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={"--mcp\ncompact"}
              />
            </label>
          </>
        ) : (
          <label className="block text-sm">
            Server URL
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
            />
          </label>
        )}
        {error ? (
          <p role="alert" className="text-sm">
            {error}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
          onClick={() => {
            if (entries.some((c) => c.name === name.trim())) {
              setError("A connection with this name already exists.");
              return;
            }
            const connection: SetupMcpConnection = {
              name: name.trim(),
              transport,
              ...(transport === "stdio" ? { command: command.trim() } : { url: url.trim() }),
              args: args
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              environment: {},
              headers: {},
              drivers: [],
              enabled: true,
            };
            onChange(encode([...entries, connection]));
            setName("");
            setCommand("");
            setArgs("");
            setUrl("");
            setError(null);
          }}
        >
          Add connection
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">Advanced connection configuration</summary>
        <p className="py-2 text-xs text-muted-foreground">
          Set harness filters, environment variables, and credential references. Bind secret values
          on each destination after applying the profile.
        </p>
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          aria-label="Advanced MCP configuration"
        />
      </details>
    </div>
  );
}
