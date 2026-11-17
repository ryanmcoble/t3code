import { appAtomRegistry } from "../../state/atom-registry";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import * as Schema from "effect/Schema";
import { File } from "expo-file-system";
import { getDocumentAsync } from "expo-document-picker";
import { requestedAppAtom } from "../../state/mcpApps";
import { useAtomValue } from "@effect/atom-react";
import {
  standaloneAppHost,
  standaloneAppMobileDocument,
  decodeNativeAppMessage,
} from "@t3tools/client-runtime/standalone-apps";
import { mcpAppStyleVariables, type McpAppHost } from "@t3tools/client-runtime/mcp-apps";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  StandaloneAppDefinition,
  type EnvironmentId,
  type StandaloneAppOpenResult,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Platform, ScrollView, View, useWindowDimensions } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const confirm = (message: string) =>
  new Promise<boolean>((resolve) =>
    Dialog.alert(
      "App action",
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Allow", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );

const decodeAppManifest = Schema.decodeUnknownSync(StandaloneAppDefinition);

export function AppsScreen() {
  const { environments } = useEnvironments();
  const requested = useAtomValue(requestedAppAtom);
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const [lastRequest, setLastRequest] = useState(requested);
  if (lastRequest !== requested) {
    setLastRequest(requested);
    setSelected(requested?.environmentId ?? null);
  }
  const environment =
    environments.find((entry) => entry.environmentId === (selected ?? requested?.environmentId)) ??
    environments[0];
  return (
    <View className="flex-1 bg-screen">
      <View className="px-4 pt-3">
        <Text className="text-xl font-t3-semibold">Apps</Text>
      </View>
      <View>
        <ScrollView horizontal contentContainerStyle={{ gap: 8, padding: 12 }}>
          {environments.map((entry) => (
            <Button
              key={entry.environmentId}
              label={entry.label}
              tone={environment?.environmentId === entry.environmentId ? "primary" : "secondary"}
              onPress={() => setSelected(entry.environmentId)}
            />
          ))}
        </ScrollView>
      </View>
      {environment?.serverConfig?.standaloneApps ? (
        <EnvironmentApps
          key={`${environment.environmentId}:${requested?.appId ?? ""}`}
          environmentId={environment.environmentId}
          initialAppId={
            requested?.environmentId === environment.environmentId ? requested.appId : undefined
          }
        />
      ) : (
        <Text className="p-4">
          {environment
            ? "Update this environment’s T3 server to use apps."
            : "Connect to an environment to open apps."}
        </Text>
      )}
    </View>
  );
}

function EnvironmentApps(props: {
  environmentId: EnvironmentId;
  initialAppId: string | undefined;
}) {
  const apps = useEnvironmentQuery(
    mcpAppEnvironment.apps({ environmentId: props.environmentId, input: {} }),
  );
  const [selectedId, setSelectedId] = useState(props.initialAppId);
  const selected = apps.data?.find((app) => app.id === selectedId);
  const document = useEnvironmentQuery(
    selected
      ? mcpAppEnvironment.appDocument({
          environmentId: props.environmentId,
          input: { appId: selected.id },
        })
      : null,
  );
  const canSave = useAtomValue(mcpAppEnvironment.saveApp.permissionAtom(props.environmentId));
  const canRemove = useAtomValue(mcpAppEnvironment.removeApp.permissionAtom(props.environmentId));
  const save = useAtomCommand(mcpAppEnvironment.saveApp, { reportFailure: false });
  const remove = useAtomCommand(mcpAppEnvironment.removeApp, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const pending = installing || document.isPending;
  return (
    <View className="min-h-0 flex-1">
      <View>
        <ScrollView horizontal contentContainerStyle={{ gap: 8, padding: 12 }}>
          {(apps.data ?? []).map((app) => (
            <Button
              key={app.id}
              label={app.title}
              disabled={pending}
              tone={selectedId === app.id ? "primary" : "secondary"}
              onPress={() => {
                setSelectedId(app.id);
                appAtomRegistry.set(requestedAppAtom, {
                  environmentId: props.environmentId,
                  appId: app.id,
                });
              }}
            />
          ))}
          <Button
            label="Refresh apps"
            onPress={() => {
              apps.refresh();
              document.refresh();
            }}
          />
          <Button
            label="Install app"
            disabled={!canSave || pending}
            onPress={async () => {
              setInstalling(true);
              setError(null);
              try {
                const result = await getDocumentAsync({
                  type: "application/json",
                  copyToCacheDirectory: true,
                });
                if (result.canceled) {
                  setInstalling(false);
                  return;
                }
                const file = new File(result.assets[0]!.uri);
                if (file.size > 128 * 1024) {
                  setError("App manifest is too large.");
                  setInstalling(false);
                  return;
                }
                const definition = decodeAppManifest(JSON.parse(await file.text()));
                if (
                  !(await confirm(
                    `Install ${definition.title} on this environment? This allows T3 to run ${definition.command} ${definition.args.join(" ")}. Install only apps you trust.`,
                  ))
                ) {
                  setInstalling(false);
                  return;
                }
                const saved = await save({ environmentId: props.environmentId, input: definition });
                if (saved._tag !== "Success") {
                  setError(String(squashAtomCommandFailure(saved)));
                  setInstalling(false);
                  return;
                }
                apps.refresh();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not install app.");
              }
              setInstalling(false);
            }}
          />
          {selected ? (
            <Button
              label="Uninstall app"
              disabled={!canRemove || pending}
              onPress={async () => {
                if (
                  !(await confirm(
                    `Uninstall ${selected.title}? Its data will remain with its server.`,
                  ))
                )
                  return;
                const result = await remove({
                  environmentId: props.environmentId,
                  input: { appId: selected.id },
                });
                if (result._tag !== "Success") {
                  setError(String(squashAtomCommandFailure(result)));
                  return;
                }
                setSelectedId(undefined);
                apps.refresh();
              }}
            />
          ) : null}
        </ScrollView>
      </View>
      {error || apps.error || document.error ? (
        <Text accessibilityRole="alert" className="p-4">
          {error ?? document.error ?? `Apps unavailable on this environment: ${apps.error}`}
        </Text>
      ) : null}
      {pending ? <Text className="p-4">Opening app…</Text> : null}
      {selected && document.data ? (
        <AppWebView
          key={`${selected.id}:${document.successResult?.timestamp}`}
          environmentId={props.environmentId}
          appId={selected.id}
          app={document.data}
        />
      ) : (
        <Text className="p-4">
          {apps.isPending
            ? "Loading apps…"
            : apps.data?.length
              ? "Select an app. No AI conversation is needed."
              : "Install an app manifest to get started."}
        </Text>
      )}
    </View>
  );
}

function AppWebView(props: {
  environmentId: EnvironmentId;
  appId: string;
  app: StandaloneAppOpenResult;
}) {
  const frame = useRef<WebView<object>>(null);
  const host = useRef<McpAppHost | null>(null);
  const [secret] = useState(uuidv4);
  const [source] = useState(() => ({ html: standaloneAppMobileDocument(props.app.html, secret) }));
  const [failed, setFailed] = useState(false);
  const { width, height } = useWindowDimensions();
  const appearance = useAppearancePreferences();
  const selectDetail = useSelectWorkspaceDetail();
  const selectTab = useSelectWorkspaceTab();
  const theme = mobileHtmlRenderTheme({
    themeId: appearance.themeId,
    appearance: appearance.themeAppearance,
    variables: appearance.themeVariables,
    systemColors: appearance.systemColorsActive,
    platform: Platform.OS,
  });
  const read = useAtomCommand(mcpAppEnvironment.readApp, { reportFailure: false });
  const write = useAtomCommand(mcpAppEnvironment.writeApp, { reportFailure: false });
  const canWrite = useAtomValue(mcpAppEnvironment.writeApp.permissionAtom(props.environmentId));
  const live = useEffectEvent(() => ({
    props,
    theme,
    read,
    write,
    width,
    height,
    canWrite,
    selectDetail,
    selectTab,
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the native WebView's sandbox message channel for the displayed app.
  useEffect(() => {
    const bridge = standaloneAppHost({
      appId: props.appId,
      stateKey: `${props.environmentId}:${props.appId}`,
      app: props.app,
      post: (message) =>
        frame.current?.injectJavaScript(
          `window.__t3AppReceive(${JSON.stringify(message).replace(/</g, "\\u003c")});true;`,
        ),
      hostContext: () => {
        const current = live();
        return {
          theme: current.theme.appearance,
          styles: { variables: mcpAppStyleVariables(current.theme.variables) },
          displayMode: "fullscreen",
          availableDisplayModes: ["fullscreen"],
          containerDimensions: { width: current.width, height: current.height },
          platform: "mobile",
          deviceCapabilities: { touch: true },
        };
      },
      confirm,
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
          const current = live();
          current.selectTab("threads");
          current.selectDetail({
            name: "Thread",
            params: {
              environmentId: link.environmentId ?? current.props.environmentId,
              threadId: link.threadId,
            },
          });
          return;
        }
        if (await confirm(`Open this link?\n${url}`)) await tryOpenExternalUrl(url, "mcp-app");
      },
    });
    host.current = bridge;
    return () => {
      host.current = null;
      bridge.dispose();
    };
  }, [props.app, props.appId, props.environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Update the external document when native theme or viewport dimensions change.
  useEffect(() => {
    host.current?.updateHostContext();
  });
  if (failed)
    return (
      <Text accessibilityRole="alert" className="p-4">
        This app stopped. Use Refresh apps to reopen it.
      </Text>
    );
  return (
    <WebView<object>
      ref={frame}
      style={{ flex: 1 }}
      source={source}
      originWhitelist={["about:blank"]}
      onError={() => {
        host.current?.dispose();
        setFailed(true);
      }}
      onContentProcessDidTerminate={() => {
        host.current?.dispose();
        setFailed(true);
      }}
      onRenderProcessGone={() => {
        host.current?.dispose();
        setFailed(true);
      }}
      javaScriptEnabled
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      onShouldStartLoadWithRequest={(request) =>
        request.url === "about:blank" || request.url === "about:srcdoc"
      }
      onMessage={(event: WebViewMessageEvent) => {
        const message = decodeNativeAppMessage(event.nativeEvent.data, secret);
        if (typeof message === "object" && message !== null && "navigationBlocked" in message) {
          host.current?.dispose();
          setFailed(true);
          return;
        }
        if (message !== undefined) host.current?.receive(message);
      }}
    />
  );
}
