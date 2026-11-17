import { observeResize } from "../../lib/observeResize";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  standaloneAppHost,
  standaloneAppWebDocument,
  rememberStandaloneAppSelection,
} from "@t3tools/client-runtime/standalone-apps";
import { isElectron } from "../../env";
import { mcpAppStyleVariables, type McpAppHost } from "@t3tools/client-runtime/mcp-apps";
import type { EnvironmentId, StandaloneAppOpenResult } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { useStableCallback } from "../../hooks/useStableCallback";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { requestConfirmDialog } from "../../confirmDialog";

export function StandaloneAppView(props: {
  environmentId: EnvironmentId;
  appId: string;
  app: StandaloneAppOpenResult;
  title: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<McpAppHost | null>(null);
  const loads = useRef(0);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const theme = useHtmlRenderTheme();
  const navigate = useNavigate();
  const canWrite = useAtomValue(mcpAppEnvironment.writeApp.permissionAtom(props.environmentId));
  const read = useAtomCommand(mcpAppEnvironment.readApp, { reportFailure: false });
  const write = useAtomCommand(mcpAppEnvironment.writeApp, { reportFailure: false });
  const live = useStableCallback(() => ({ props, theme, read, write, navigate, canWrite }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Bind the sandbox's message channel to the environment-owned app connection.
  useEffect(() => {
    rememberStandaloneAppSelection(props.environmentId, props.appId);
    const host = standaloneAppHost({
      appId: props.appId,
      stateKey: `${props.environmentId}:${props.appId}`,
      app: props.app,
      post: (message) => frame.current?.contentWindow?.postMessage(message, "*"),
      hostContext: () => ({
        theme: live().theme.appearance,
        styles: { variables: mcpAppStyleVariables(live().theme.variables) },
        displayMode: "fullscreen",
        availableDisplayModes: ["fullscreen"],
        containerDimensions: {
          width: frame.current?.clientWidth ?? 800,
          height: frame.current?.clientHeight ?? 600,
        },
        platform: isElectron ? "desktop" : "web",
      }),
      confirm: async (message) => (await requestConfirmDialog(message)) === true,
      call: async (name, args, isWrite) => {
        const current = live();
        if (isWrite && !current.canWrite)
          throw new Error("This connection does not allow changes.");
        const result = await (isWrite ? current.write : current.read)({
          environmentId: current.props.environmentId,
          input: { appId: current.props.appId, name, arguments: args },
        });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        return result.value;
      },
      openLink: async (url) => {
        const link = parseThreadLinkHref(url);
        if (link) {
          await live().navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: link.environmentId ?? live().props.environmentId,
              threadId: link.threadId,
            },
          });
          return;
        }
        if (await requestConfirmDialog(`Open this link?\n${url}`))
          window.open(url, "_blank", "noopener,noreferrer");
      },
    });
    hostRef.current = host;
    const stopResize = frame.current
      ? observeResize(frame.current, () => host.updateHostContext())
      : () => {};
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.navigationBlocked) {
        host.dispose();
        setNavigatedAway(true);
      } else host.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      stopResize();
      hostRef.current = null;
      window.removeEventListener("message", receive);
      host.dispose();
    };
  }, [props.appId, props.app, props.environmentId, live]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Send changed theme tokens to the external app document.
  useEffect(() => {
    hostRef.current?.updateHostContext();
  });
  if (navigatedAway)
    return (
      <p role="alert" className="p-4">
        This app left its page and was stopped. Refresh to reopen it.
      </p>
    );
  return (
    <iframe
      ref={frame}
      title={props.title}
      onLoad={() => {
        if (++loads.current > 1) {
          hostRef.current?.dispose();
          setNavigatedAway(true);
        }
      }}
      className="h-full min-h-0 w-full flex-1 border-0"
      sandbox="allow-scripts allow-forms"
      srcDoc={standaloneAppWebDocument(props.app.html)}
    />
  );
}
