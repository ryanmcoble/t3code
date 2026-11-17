import { describe, expect, it } from "vite-plus/test";
import {
  standaloneAppHost,
  standaloneAppHtml,
  standaloneAppMobileDocument,
  decodeNativeAppMessage,
} from "./standalone.ts";

describe("standalone app host", () => {
  it("negotiates without conversation capabilities and refuses unregistered or declined writes", async () => {
    const sent: unknown[] = [];
    const calls: string[] = [];
    const links: string[] = [];
    const host = standaloneAppHost({
      appId: "test",
      app: {
        html: "<p>App</p>",
        resourceUri: "ui://test/app",
        readTools: ["read"],
        writeTools: ["write"],
      },
      post: (value) => sent.push(value),
      hostContext: () => ({
        theme: "dark",
        styles: { variables: {} },
        displayMode: "fullscreen",
        availableDisplayModes: ["fullscreen"],
        containerDimensions: { width: 400, height: 800 },
        platform: "mobile",
      }),
      call: async (name) => {
        calls.push(name);
        return { content: [] };
      },
      confirm: async () => false,
      openLink: async (url) => {
        links.push(url);
      },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26" },
    });
    const initialized = sent[0] as { result: { hostCapabilities: Record<string, unknown> } };
    expect(initialized.result.hostCapabilities.message).toBeUndefined();
    expect(initialized.result.hostCapabilities.updateModelContext).toBeUndefined();
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    for (const [id, name] of [
      [2, "write"],
      [3, "unknown"],
      [4, "read"],
    ] as const)
      host.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["read"]);
    for (const url of ["t3-thread://v2/example", "https://example.com", "javascript:alert(1)"])
      host.receive({ jsonrpc: "2.0", id: url, method: "ui/open-link", params: { url } });
    await Promise.resolve();
    await Promise.resolve();
    expect(links).toEqual(["t3-thread://v2/example", "https://example.com"]);
    host.dispose();
  });

  it("blocks app network access and authenticates the mobile bridge outside the sandbox", () => {
    expect(standaloneAppHtml("<!doctype html><script>window.run=1</script>")).toContain(
      "connect-src 'none'",
    );
    const document = standaloneAppMobileDocument("</script><script>app()</script>", "secret-token");
    expect(document).toContain('sandbox="allow-scripts allow-forms"');
    expect(document).not.toContain("allow-same-origin");
    expect(document).toContain("e.source===frame.contentWindow");
    expect(document).toContain("secret:secret");
    expect(
      decodeNativeAppMessage(
        JSON.stringify({ secret: "forged", message: { method: "tools/call" } }),
        "secret-token",
      ),
    ).toBeUndefined();
    expect(
      decodeNativeAppMessage(
        JSON.stringify({ secret: "secret-token", message: { method: "ping" } }),
        "secret-token",
      ),
    ).toEqual({ method: "ping" });
    expect(document).toContain("\\u003c/script>");
  });

  it("restores app view state after reopening and keeps environments separate", () => {
    const sent: Array<{ result?: unknown }> = [];
    const create = (stateKey: string) =>
      standaloneAppHost({
        appId: "state-test",
        stateKey,
        app: { html: "", resourceUri: "ui://test/state", readTools: [], writeTools: [] },
        post: (message) => sent.push(message as { result?: unknown }),
        hostContext: () => ({
          theme: "dark",
          styles: { variables: {} },
          displayMode: "fullscreen",
          availableDisplayModes: ["fullscreen"],
          containerDimensions: { width: 400, height: 800 },
          platform: "mobile",
        }),
        call: async () => ({ content: [] }),
        confirm: async () => false,
        openLink: async () => {},
      });
    const first = create("environment-a:state-test");
    first.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "t3/view-state.set",
      params: { product: "acd", selected: "item-1" },
    });
    first.dispose();
    first.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "t3/view-state.set",
      params: { product: "wrong" },
    });
    const reopened = create("environment-a:state-test");
    reopened.receive({ jsonrpc: "2.0", id: 3, method: "t3/view-state.get" });
    expect(sent.at(-1)?.result).toEqual({ product: "acd", selected: "item-1" });
    const other = create("environment-b:state-test");
    other.receive({ jsonrpc: "2.0", id: 4, method: "t3/view-state.get" });
    expect(sent.at(-1)?.result).toBeNull();
    reopened.dispose();
    other.dispose();
  });
});
