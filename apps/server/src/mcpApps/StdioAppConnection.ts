// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node subprocess adapter owns stdio callbacks and their cleanup timers.
import * as NodeChildProcess from "node:child_process";

const MAX_BYTES = 6 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** A server-owned MCP connection; it never creates a provider session or retries a tool call. */
export function openStdioAppConnection(command: string, args: readonly string[], cwd: string) {
  const environment = { ...process.env };
  for (const key of [
    "T3CODE_THREAD_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDECODE",
    "COPILOT_SESSION_ID",
    "COPILOT_AGENT_SESSION_ID",
    "OPENCODE_SESSION_ID",
  ])
    delete environment[key];
  const child = NodeChildProcess.spawn(command, [...args], {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let sequence = 0;
  let buffer = "";
  let stopped = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const close = (error = new Error("App connection closed. Open the app again to reconnect.")) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(idle);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    child.stdin.destroy();
    child.kill();
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => close(), 5 * 60_000);
    idle.unref();
  };
  const send = (message: unknown) => {
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error("App request is too large.");
    child.stdin.write(`${line}\n`);
  };
  child.stderr.resume();
  child.stdin.on("error", () => close(new Error("App connection is unavailable.")));
  child.on("error", (error) => close(new Error(`Could not start app: ${error.message}`)));
  child.on("exit", () => close(new Error("App server stopped. Open the app again to reconnect.")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_BYTES)
      return close(new Error("App response is too large."));
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (typeof message !== "object" || message === null)
          throw new Error("Invalid MCP message.");
        const response = message as {
          id?: unknown;
          method?: unknown;
          result?: unknown;
          error?: unknown;
        };
        // Server-initiated requests have no authority to run host tools or ask for secrets.
        if (typeof response.method === "string") {
          if (response.id !== undefined)
            send({
              jsonrpc: "2.0",
              id: response.id,
              error: { code: -32601, message: "Host method not supported" },
            });
          continue;
        }
        if (typeof response.id !== "number") continue;
        const request = pending.get(response.id);
        if (!request) continue;
        pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.error !== undefined)
          request.reject(new Error("App server rejected the request."));
        else request.resolve(response.result);
      } catch {
        close(new Error("App server returned invalid MCP JSON."));
      }
    }
  });
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (stopped)
      return Promise.reject(new Error("App connection stopped. Open the app again to reconnect."));
    if (pending.size >= 16) return Promise.reject(new Error("Too many app requests."));
    touch();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => close(new Error("App request timed out; it was not retried.")),
        REQUEST_TIMEOUT_MS,
      );
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        close(error instanceof Error ? error : new Error("App request failed."));
      }
    });
  };
  const ready = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {
      extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
    },
    clientInfo: { name: "t3code-apps", version: "1" },
  }).then(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  // Register immediately so a failed spawn cannot become an unhandled rejection.
  void ready.catch(() => {});
  return {
    close,
    get stopped() {
      return stopped;
    },
    request: async (method: string, params: unknown) => {
      await ready;
      return request(method, params);
    },
  };
}
