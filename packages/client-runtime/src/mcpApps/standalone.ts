import type { StandaloneAppOpenResult, McpAppCallToolResult } from "@t3tools/contracts";
import { injectMcpAppCsp } from "@t3tools/shared/mcpApp";
import { makeMcpAppHost, McpAppHostRefusal, type McpAppHostContext } from "./host.ts";

const viewStates = new Map<string, unknown>();
const appSelections = new Map<string, string>();
export const standaloneAppSelection = (environmentId: string) => appSelections.get(environmentId);
export function rememberStandaloneAppSelection(environmentId: string, appId: string | undefined) {
  if (appId === undefined) appSelections.delete(environmentId);
  else appSelections.set(environmentId, appId);
}

export function standaloneAppHost(input: {
  appId: string;
  stateKey?: string;
  app: StandaloneAppOpenResult;
  post: (message: unknown) => void;
  hostContext: () => McpAppHostContext;
  call: (
    name: string,
    args: Record<string, unknown>,
    write: boolean,
  ) => Promise<McpAppCallToolResult>;
  confirm: (message: string) => Promise<boolean>;
  openLink: (url: string) => Promise<void>;
}) {
  const unavailable = async () => {
    throw new McpAppHostRefusal("This action is not available in a standalone app.");
  };
  const host = makeMcpAppHost({
    app: {
      attachmentId: input.appId,
      server: input.appId,
      tool: "",
      resourceUri: input.app.resourceUri,
    },
    hostVersion: "1",
    standalone: true,
    post: input.post,
    hostContext: input.hostContext,
    callTool: async ({ name, arguments: args }) => {
      const write = input.app.writeTools.includes(name);
      if (!write && !input.app.readTools.includes(name))
        throw new McpAppHostRefusal("This app cannot call that tool.");
      if (
        write &&
        !(await input.confirm(
          `Allow this app to make this change?\n${JSON.stringify(args, null, 2)}`,
        ))
      )
        throw new McpAppHostRefusal("Change cancelled.");
      return input.call(name, args, write);
    },
    readResource: async ({ uri }) => {
      if (uri !== input.app.resourceUri)
        throw new McpAppHostRefusal("This resource is not available to the app.");
      return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: input.app.html }] };
    },
    openLink: async (url) => {
      if (!/^(https?:|t3-thread:)/i.test(url)) throw new McpAppHostRefusal("Unsupported link.");
      await input.openLink(url);
    },
    sendMessage: unavailable,
    updateModelContext: unavailable,
    requestDisplayMode: async () => "fullscreen",
    downloadFile: unavailable,
    onRequestTeardown: () => {},
    onSizeChanged: () => {},
  });
  let disposed = false;
  return {
    ...host,
    dispose: () => {
      disposed = true;
      host.dispose();
    },
    receive: (message: unknown) => {
      if (disposed) return;
      if (
        typeof message !== "object" ||
        message === null ||
        !("method" in message) ||
        !["t3/view-state.get", "t3/view-state.set"].includes(String(message.method))
      ) {
        host.receive(message);
        return;
      }
      if (!("id" in message) || (typeof message.id !== "string" && typeof message.id !== "number"))
        return;
      const key = input.stateKey ?? input.appId;
      try {
        if (message.method === "t3/view-state.set" && "params" in message) {
          const encoded = JSON.stringify(message.params);
          if (new TextEncoder().encode(encoded).byteLength > 16 * 1024)
            throw new Error("App view state is too large.");
          if (!viewStates.has(key) && viewStates.size >= 64)
            viewStates.delete(viewStates.keys().next().value!);
          viewStates.set(key, JSON.parse(encoded));
        }
        input.post({ jsonrpc: "2.0", id: message.id, result: viewStates.get(key) ?? null });
      } catch {
        input.post({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Invalid app view state." },
        });
      }
    },
  };
}

export const standaloneAppHtml = (html: string) => injectMcpAppCsp(html, undefined);

// The enclosing policy blocks inner-frame navigation before an external request leaves.
const outerCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-src about:; connect-src 'none'; form-action 'none'; base-uri 'none'";
function standaloneAppDocument(html: string, secret?: string) {
  const outgoing =
    secret === undefined
      ? "parent.postMessage(m,'*')"
      : "window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,message:m}))";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${outerCsp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe id="app" sandbox="allow-scripts allow-forms"></iframe><script>(function(){var frame=document.getElementById('app'),secret=${JSON.stringify(secret ?? "")},loads=0,live=true;function send(m){${outgoing};}frame.addEventListener('load',function(){if(++loads>1){live=false;send({navigationBlocked:true});}});window.addEventListener('message',function(e){if(!live)return;if(e.source===frame.contentWindow)send(e.data);else if(e.source===parent)frame.contentWindow.postMessage(e.data,'*');});window.__t3AppReceive=function(m){if(live)frame.contentWindow.postMessage(m,'*');};frame.srcdoc=${JSON.stringify(standaloneAppHtml(html)).replace(/</g, "\\u003c")};})();</script></body></html>`;
}
export const standaloneAppWebDocument = (html: string) => standaloneAppDocument(html);
/** The outer frame authenticates messages even on Android, where nested frames can reach the native bridge. */
export const standaloneAppMobileDocument = (html: string, secret: string) =>
  standaloneAppDocument(html, secret);

export function decodeNativeAppMessage(data: string, secret: string): unknown {
  if (data.length > 256 * 1024) return undefined;
  try {
    const envelope: unknown = JSON.parse(data);
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      "secret" in envelope &&
      envelope.secret === secret &&
      "message" in envelope
    )
      return envelope.message;
  } catch {
    return undefined;
  }
  return undefined;
}
