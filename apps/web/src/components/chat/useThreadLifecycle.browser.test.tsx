import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { RunStopPresentation } from "@t3tools/client-runtime/state/thread-execution";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

const backend = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    exists: false,
    stop: Atom.make<RunStopPresentation | null>(null),
  };
});

vi.mock("../ChatView.logic", () => ({
  isThreadWokeUnseen: () => false,
  branchMismatchKey: () => null,
  isBranchMismatchDismissedForSession: () => false,
  shouldShowBranchMismatchBanner: () => false,
  chatActionErrorMessage: () => "Command failed",
}));
vi.mock("../Sidebar.logic", () => ({ resolveThreadLastVisitedAt: () => null }));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: async () => undefined,
    pinThread: async () => undefined,
    confirmAndUnpinThread: async () => undefined,
  }),
  useAcknowledgeThreadWoke: () => () => undefined,
}));
vi.mock("../../settleAndAdvance", () => ({ settleAndAdvance: () => false }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => false,
  readEnvironmentScope: () => false,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../../state/entities", () => ({
  useChildThreadInputs: () => [],
  readThreadShell: () => null,
  waitForThreadShell: async () => null,
}));
vi.mock("./useForceStopThread", () => ({
  useForceStopThread: () => ({ canForceStop: false, stoppingThreadId: null }),
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const runStop = Atom.family((_key: string) =>
    Atom.make((get) => {
      // Opening a detail stream before creation produces a definitive 404 in the real loader.
      if (!backend.exists) throw new Error("Draft detail requested before thread creation");
      return get(backend.stop);
    }),
  );
  return {
    threadEnvironment: {},
    environmentThreadDetails: {
      runStopAtom: (ref: { threadId: string }) => runStop(ref.threadId),
    },
  };
});

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadLifecycle } from "./useThreadLifecycle";

const ENVIRONMENT_ID = EnvironmentId.make("environment:draft-lifecycle");
const THREAD_ID = ThreadId.make("thread:draft-lifecycle");
const THREAD_REF = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
const THREAD = { id: THREAD_ID, environmentId: ENVIRONMENT_ID } as EnvironmentThreadShell;
const noop = () => undefined;

function Harness({ created }: { readonly created: boolean }) {
  const lifecycle = useThreadLifecycle({
    environmentId: ENVIRONMENT_ID,
    routeThreadKey: "draft-lifecycle",
    currentRouteThreadKeyRef: { current: "draft-lifecycle" },
    canOperateThread: false,
    clientSettingsHydrated: true,
    activeThread: THREAD,
    activeThreadId: THREAD_ID,
    activeThreadRef: THREAD_REF,
    activeThreadKey: "draft-lifecycle",
    activeThreadShell: created ? THREAD : null,
    activeLatestRun: null,
    activeProjectCwd: null,
    serverConfig: null,
    runtimeMode: "full-access",
    isWorking: false,
    pendingBackgroundTasks: [],
    turnItems: [],
    activePendingApproval: null,
    activePendingUserInput: null,
    localCheckoutBranchMismatch: null,
    gitStatusQuery: { refresh: noop },
    nowMinute: "2026-10-30T22:00",
    composerRef: { current: null },
    composerDraftTarget: THREAD_REF,
    sendInFlightRef: { current: false },
    setOptimisticUserMessages: noop,
    setThreadError: noop,
    clearUsageLimitsFor: noop,
    beginLocalDispatch: noop,
    resetLocalDispatch: noop,
    scheduleComposerFocus: noop,
    scrollToEnd: noop,
    persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
  });
  return <div role="status">{lifecycle.workNow?.title ?? "No pending stop"}</div>;
}

function view(created: boolean) {
  return (
    <AppAtomRegistryProvider>
      <Harness created={created} />
    </AppAtomRegistryProvider>
  );
}

it("waits for draft creation before loading detail and observes Stop after promotion", async () => {
  backend.exists = false;
  appAtomRegistry.set(backend.stop, null);
  await using screen = await render(view(false));
  await expect.element(screen.getByRole("status")).toHaveTextContent("No pending stop");

  backend.exists = true;
  appAtomRegistry.set(backend.stop, {
    state: "stopping",
    runId: RunId.make("run:draft-lifecycle"),
    requestedAt: "2026-10-30T22:00:00.000Z",
    background: false,
  });
  await screen.rerender(view(true));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Stopping");

  await act(() => appAtomRegistry.set(backend.stop, null));
  await expect.element(screen.getByRole("status")).toHaveTextContent("No pending stop");
});
