import * as NodeReadline from "node:readline";

let writes = 0;
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const { method, params } = message;
  let result;
  if (method === "initialize")
    result = {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "test-app", version: "1" },
    };
  else if (method === "resources/read")
    result = {
      contents: [
        {
          uri: params.uri,
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><title>Test app</title>",
        },
      ],
    };
  else if (method === "tools/list")
    result = {
      tools: [
        { name: "read", annotations: { readOnlyHint: true } },
        { name: "write", annotations: { readOnlyHint: false } },
      ],
    };
  else if (method === "tools/call") {
    if (params.name === "write") writes++;
    if (params.arguments?.crash) {
      process.stdout.write("invalid-json\n");
      return;
    }
    result = { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, writes }) }] };
  } else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unknown method" },
      }) + "\n",
    );
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
