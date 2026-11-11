import { useAtomValue } from "@effect/atom-react";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { sharedProjectFileStatus } from "@t3tools/client-runtime/state/shared-capabilities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SharedProjectBinding,
  SharedProjectManifest,
  SharedProjectSubscription,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sharedCapabilities } from "../../state/sharedCapabilities";
import { useAtomCommand } from "../../state/use-atom-command";

export function SharedProjectFilesSection({
  environmentId,
  project,
  binding,
  subscription,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: SharedProjectManifest | undefined;
  readonly binding: SharedProjectBinding | undefined;
  readonly subscription: SharedProjectSubscription;
}) {
  const { environments } = useEnvironments();
  const owner = environments.find(
    (machine) => machine.environmentId === subscription.ownerEnvironmentId,
  );
  const sourceUrl = linkableMachines({
    environments,
    threadEnvironmentId: environmentId,
    links: [],
    connect: new Map(),
  })
    .find((machine) => machine.environmentId === subscription.ownerEnvironmentId)
    ?.urls.find((url) => url.startsWith("https://"));
  const canGrant = useAtomValue(
    sharedCapabilities.sharedProjectGrant.permissionAtom(subscription.ownerEnvironmentId),
  );
  const canReceive = useAtomValue(
    sharedCapabilities.sharedProjectEnrollmentCommand.permissionAtom(environmentId, {
      operation: "connect",
      receiveFiles: true,
    }),
  );
  const canConfigure = useAtomValue(
    sharedCapabilities.sharedProjectEnrollmentCommand.permissionAtom(environmentId),
  );
  const canAct = useAtomValue(
    sharedCapabilities.sharedProjectContentCommand.permissionAtom(environmentId),
  );
  const enroll = useAtomCommand(sharedCapabilities.enrollSharedProject, { reportFailure: false });
  const configure = useAtomCommand(sharedCapabilities.sharedProjectEnrollmentCommand, {
    reportFailure: false,
  });
  const command = useAtomCommand(sharedCapabilities.sharedProjectContentCommand, {
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const state = useEnvironmentQuery(
    expanded && project
      ? sharedCapabilities.sharedProjectContentState({
          environmentId,
          input: { sharedProjectId: project.id },
        })
      : null,
  );
  const [review, setReview] = useState<{
    readonly rootId: string;
    readonly generation: number;
    readonly cursor: number;
  } | null>(null);
  const conflicts = useEnvironmentQuery(
    review
      ? sharedCapabilities.sharedProjectContentConflict({
          environmentId,
          input: {
            sharedProjectId: subscription.sharedProjectId,
            rootId: review.rootId,
            cursor: review.cursor,
          },
        })
      : null,
  );
  const toggle = async () => {
    if (inFlight.current || (!subscription.receiveFiles && (!sourceUrl || !project))) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (subscription.receiveFiles)
        result = await configure({
          environmentId,
          input: {
            operation: "receive-files",
            sharedProjectId: subscription.sharedProjectId,
            enabled: false,
          },
        });
      else
        result = await enroll({
          ownerId: subscription.ownerEnvironmentId,
          destinationId: environmentId,
          sharedProjectId: subscription.sharedProjectId,
          sourceUrl: sourceUrl!,
          receiveFiles: true,
        });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else setExpanded(true);
    } catch {
      setError("Could not change file receiving. Refresh the connection and retry.");
    }
    inFlight.current = false;
    setBusy(false);
  };
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else if (input.operation === "resolve") setReview(null);
    } catch {
      setError("Could not update folder preparation. Refresh its status and retry.");
    }
    inFlight.current = false;
    setBusy(false);
  };
  const resolve = (choice: "local" | "owner") => {
    if (!review) return;
    const input = {
      operation: "resolve" as const,
      sharedProjectId: subscription.sharedProjectId,
      rootId: review.rootId,
      expectedGeneration: review.generation,
      choice,
    };
    Alert.alert(
      choice === "owner" ? "Use saved owner versions?" : "Keep local versions?",
      choice === "owner"
        ? "Use the owner's saved versions for all conflicts in this folder. Saved local versions will be preserved."
        : "Keep this machine's versions for all conflicts in this folder. Saved owner versions will be preserved.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          style: choice === "owner" ? "destructive" : "default",
          onPress: () => void run(input),
        },
      ],
    );
  };
  const canEnable =
    !!project &&
    project.roots.some((root) => root.kind === "files") &&
    !!sourceUrl &&
    owner?.serverConfig?.environment.capabilities.sharedProjectFileContent === 1 &&
    canGrant &&
    canReceive;
  const changed = !!review && !!conflicts.data && review.generation !== conflicts.data.generation;
  return (
    <View>
      <View className="p-4 gap-1">
        <Text>File receiving {subscription.receiveFiles ? "on" : "off"}</Text>
        <Text className="text-xs text-foreground-muted">
          Receives the owner's non-Git file folders in the background. Local edits stay local;
          conflicts keep both versions. Git repositories and account sign-ins are prepared
          separately.
        </Text>
        {!subscription.receiveFiles && !canEnable ? (
          <Text className="text-xs text-foreground-muted">
            Choose a mapped file folder, an updated owner with a reachable HTTPS route, and access
            to manage its grant and write files here.
          </Text>
        ) : null}
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      </View>
      <ListActionRow
        label={subscription.receiveFiles ? "Stop receiving files" : "Receive file folders"}
        disabled={busy || (subscription.receiveFiles ? !canConfigure : !canEnable)}
        onPress={() => void toggle()}
      />
      <ListActionRow
        label={expanded ? "Hide folder status" : "Folder preparation"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <View>
          {state.error ? (
            <View className="p-4">
              <Text accessibilityRole="alert">{state.error}</Text>
            </View>
          ) : null}
          {!project ? (
            <View className="p-4">
              <Text>Refresh the owner's project definitions first.</Text>
            </View>
          ) : !state.data ? (
            <View className="p-4">
              <Text>Loading folder status…</Text>
            </View>
          ) : (
            project.roots.map((root) => {
              const receipt = state.data?.roots.find((value) => value.rootId === root.id);
              const status = sharedProjectFileStatus({
                project,
                binding,
                subscription,
                receipt,
                environmentId,
              });
              return (
                <View key={root.id}>
                  <View className="p-4 gap-1">
                    <Text>
                      {root.name} ·{" "}
                      {root.kind === "git" ? "Repository setup required" : status.title}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {root.kind === "git"
                        ? "Git history is not transferred by file receiving."
                        : status.detail}
                    </Text>
                  </View>
                  {root.kind === "files" ? (
                    <>
                      <ListActionRow
                        label={`Check ${root.name} preparation`}
                        disabled={
                          busy || !canAct || !subscription.receiveFiles || subscription.paused
                        }
                        onPress={() =>
                          void run({
                            operation: "refresh",
                            sharedProjectId: project.id,
                            rootId: root.id,
                          })
                        }
                      />
                      {receipt?.conflictCount ? (
                        <ListActionRow
                          label={`Review ${root.name} conflicts`}
                          disabled={busy}
                          onPress={() =>
                            setReview({
                              rootId: root.id,
                              generation: receipt.generation,
                              cursor: 0,
                            })
                          }
                        />
                      ) : null}
                    </>
                  ) : null}
                </View>
              );
            })
          )}
        </View>
      ) : null}
      {review ? (
        <View>
          <View className="p-4 gap-1">
            <Text>Review folder conflicts</Text>
            <Text className="text-xs text-foreground-muted">
              Choose saved versions for all conflicting paths in this folder. Both versions remain
              preserved; later local edits are protected.
            </Text>
            {conflicts.error ? (
              <Text accessibilityRole="alert">{conflicts.error}</Text>
            ) : !conflicts.data ? (
              <Text>Loading conflicts…</Text>
            ) : (
              <>
                <Text>{conflicts.data.total} conflicting paths</Text>
                {changed ? (
                  <Text accessibilityRole="alert">
                    The conflict changed. Reload it before choosing a version.
                  </Text>
                ) : null}
                {conflicts.data.paths.map((path) => (
                  <Text key={path} className="text-xs" selectable>
                    {path}
                  </Text>
                ))}
              </>
            )}
          </View>
          <ListActionRow
            label="Previous paths"
            disabled={busy || review.cursor === 0}
            onPress={() => setReview({ ...review, cursor: Math.max(0, review.cursor - 64) })}
          />
          <ListActionRow
            label="Next paths"
            disabled={busy || !conflicts.data || conflicts.data.nextCursor === null}
            onPress={() => {
              if (conflicts.data?.nextCursor !== null && conflicts.data?.nextCursor !== undefined)
                setReview({ ...review, cursor: conflicts.data.nextCursor });
            }}
          />
          <ListActionRow
            label="Reload conflict"
            disabled={busy}
            onPress={() => {
              if (conflicts.data)
                setReview({ ...review, generation: conflicts.data.generation, cursor: 0 });
              conflicts.refresh();
            }}
          />
          <ListActionRow
            label="Keep local versions"
            disabled={busy || !canAct || changed || !conflicts.data}
            onPress={() => resolve("local")}
          />
          <ListActionRow
            label="Use saved owner versions"
            tone="danger"
            disabled={busy || !canAct || changed || !conflicts.data}
            onPress={() => resolve("owner")}
          />
          <ListActionRow label="Close review" disabled={busy} onPress={() => setReview(null)} />
        </View>
      ) : null}
    </View>
  );
}
