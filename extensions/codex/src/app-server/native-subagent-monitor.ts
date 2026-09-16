/**
 * Mirrors Codex native subagent lifecycle and completion into OpenClaw task
 * runtime records, with app-server history as the recovery source.
 */
import { randomUUID } from "node:crypto";
import {
  embeddedAgentLog,
  emitAgentEvent,
  formatErrorMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  isDurableAgentHarnessCompletionDelivery,
  type AgentHarnessTaskRecord,
  type AgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  asFiniteNumber,
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  claimCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  type CodexAppServerLiveThreadOwnership,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { projectNormalizedToolItem } from "./event-projector-events.js";
import { readItem } from "./event-projector-values.js";
import { CodexNativeSubagentDeliveryReceipts } from "./native-subagent-delivery-receipts.js";
import {
  readCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import {
  codexNativeSubagentNotifications as nativeSubagentNotifications,
  type CodexNativeSubagentCompletion,
} from "./native-subagent-notification.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
  codexNativeSubagentRunId,
  readCodexNativeSubagentRunId,
} from "./native-subagent-task-ids.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime: typeof createAgentHarnessTaskRuntime;
  deliverAgentHarnessTaskCompletion: typeof deliverAgentHarnessTaskCompletion;
};

type NativeSubagentMonitorClient = Pick<
  CodexAppServerClient,
  "request" | "addNotificationHandler" | "addCloseHandler" | "getTransportPid"
>;

type ParentOwner = {
  turnId?: string;
  claimDirectChild?: (threadId: string) => (() => void) | undefined;
  rejectPendingDirectChild?: (threadId: string, reason: string) => void;
  onDirectChildAccepted?: () => void;
};

type ParentState = {
  parentThreadId: string;
  // Overlapping runs share this parent; the last owner releases it only after
  // detached children finish recovery and delivery.
  owners: Map<symbol, ParentOwner>;
  // turn/started can precede bindTurn; retain receipt ownership until the
  // foreground run has finalized its reply and releases this registration.
  turnIds: Set<string>;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  historyOwner?: CodexNativeSubagentHistoryOwner;
  agentId?: string;
  taskRuntime?: AgentHarnessTaskRuntime;
  mirror?: CodexNativeSubagentTaskMirror;
};

type DirectSpawnEvidence = {
  parentThreadId: string;
  childThreadId: string;
  agentPath?: string;
};
type NativeChildAdmissionEvidence = DirectSpawnEvidence &
  (
    | { kind: "spawn" }
    | {
        kind: "interaction";
        nativeTurnId?: string;
        itemId?: string;
        owner?: ParentOwner;
        admittedOwner?: ParentOwner;
      }
  );

type NativeExecutionWait = {
  kind: "approval" | "user_input" | "agent_messages" | "children";
  dependencies?: Array<{ runId: string }>;
  pendingCount?: number;
};

type NativeTurnEnd = "completed" | "failed" | "interrupted";
type NativeTurnState = "active" | NativeTurnEnd;
type NativeTurnObservation = {
  turnId: string;
  state: NativeTurnState | undefined;
  startObserved?: true;
};

type NativeSubagentAssignment = {
  runId: string;
  childThreadId: string;
  nativeTurnId: string | undefined;
};

type ChildState = NativeSubagentAssignment & {
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  parentThreadId: string;
  readonly agentId?: string;
  nativeTurnState?: NativeTurnState;
  activityWait?: { itemId: string; wait: NativeExecutionWait };
  activityObserved?: true;
  assistantMessagesByTurn: Map<string, ChildAssistantMessages>;
  recoveryAttempt: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  recoveryInFlight?: Promise<boolean>;
  terminal: boolean;
  fallbackCompletion?: RecoveredCompletion;
  pendingCompletion?: RecoveredCompletion;
  completionTaskPhase?: "finalize" | "delivery";
  completionTaskId?: string;
  subscriptionClosed?: true;
  nativeCompletionDelivered: boolean;
  completionDeliveryAttempt: number;
  completionDeliveryTimer?: ReturnType<typeof setTimeout>;
  deliveringCompletion: boolean;
  deliveryOwnerKey?: string;
  settledWithoutCompletion: boolean;
  releaseDirectChild?: () => void;
  directOwner?: ParentOwner;
};

type KnownChild = {
  parent: ParentState;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  assignment: NativeSubagentAssignment & { terminal: boolean; unanchored?: true };
  turnId?: string;
  observedTurns: Map<string, { awaitingInteraction?: true }>;
  pendingTurns: Array<{
    turnId: string;
    state: NativeTurnState | undefined;
    admittedOwner?: ParentOwner;
  }>;
  agentPaths: Set<string>;
};

type ChildAssistantMessages = {
  texts: Map<string, string>;
  order: string[];
  commentaryIds: Set<string>;
  finalMessageIds: Set<string>;
};

type RecoveredCompletion = CodexNativeSubagentCompletion & {
  completedAt?: number;
};

type ThreadRecovery = {
  parentThreadId?: string;
  agentPath?: string;
  assignmentTurnId?: string;
  nativeTurnId?: string;
  nativeTurnState?: NativeTurnState;
  observedPendingTurns: Array<{ turnId: string; state: NativeTurnState | undefined }>;
  completion?: RecoveredCompletion;
  fallbackCompletion?: RecoveredCompletion;
  resumable: boolean;
  threadState: "unavailable" | "active" | "system_error" | "other";
};

type ThreadStatusRevision = {
  value: number;
  readers: number;
  terminal?: true;
  parentThreadId?: string;
};

type TaskRecoveryCandidate = NativeSubagentAssignment & {
  terminal: boolean;
  observedTurns: NativeTurnObservation[];
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  parentState: ParentState;
  recoveryAttempt: number;
  requesterSessionKey: string;
  taskRuntimeScope: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime: AgentHarnessTaskRuntime;
};

type MonitorOptions = {
  recoveryPollDelaysMs?: readonly number[];
  completionDeliveryRetryDelaysMs?: readonly number[];
  completionDeliveryMaxRetries?: number;
  now?: () => number;
  retainClient?: () => (() => void) | undefined;
  retainParentThread?: (threadId: string) => (() => void) | undefined;
  claimChildThread?: (threadId: string) => Promise<unknown>;
  retainChildThread?: (threadId: string) => Promise<unknown>;
  releaseChildThread?: (threadId: string) => Promise<unknown>;
};

const DEFAULT_RECOVERY_POLL_DELAYS_MS = [
  2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS = 60_000;
const THREAD_READ_TIMEOUT_MS = 30_000;
const NATIVE_SUBAGENT_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/started",
  "item/completed",
  // App-server exposes no typed terminal subagent result. Keep this one raw
  // boundary until its protocol provides the child's terminal status and text.
  "rawResponseItem/completed",
]);
const RECOVERY_REVISION_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
]);
const MAX_PENDING_CHILD_ADMISSION_EVIDENCE = 32;

const defaultRuntime: NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
};

const monitors = new WeakMap<CodexAppServerClient, Monitor>();
const completionDeliveryOwners = new Map<string, ChildState>();

function registerMonitor(params: {
  client: CodexAppServerClient;
  parentThreadId: string;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  historyOwner?: CodexNativeSubagentHistoryOwner;
  agentId?: string;
  runtime?: NativeSubagentMonitorRuntime;
  retainClient?: () => (() => void) | undefined;
  retainParentThread?: (threadId: string) => (() => void) | undefined;
  claimDirectChild?: (threadId: string) => (() => void) | undefined;
  rejectPendingDirectChild?: (threadId: string, reason: string) => void;
  onDirectChildAccepted?: () => void;
}): { bindTurn: (turnId: string) => void; unregister: () => void } {
  let monitor = monitors.get(params.client);
  if (!monitor) {
    // Native start/completion can race; serialize each child so only its
    // original claim handle may publish or release the same subscription.
    const childThreadOwnership = new Map<string, CodexAppServerLiveThreadOwnership>();
    const childThreadTransitions = new KeyedAsyncQueue();
    monitor = new Monitor(params.client, params.runtime ?? defaultRuntime, {
      retainClient: params.retainClient,
      retainParentThread: params.retainParentThread,
      claimChildThread: (threadId) =>
        childThreadTransitions.enqueue(threadId, async () => {
          // Codex subscribes fresh children before thread/started; they have
          // no idle entry yet but must already be fenced from manual adoption.
          const ownership = await claimCodexAppServerLiveThread(params.client, threadId);
          if (ownership) {
            childThreadOwnership.set(threadId, ownership);
          }
          return ownership;
        }),
      retainChildThread: (threadId) =>
        childThreadTransitions.enqueue(threadId, async () => {
          const ownership = childThreadOwnership.get(threadId);
          let retained = false;
          try {
            retained = await retainCodexAppServerLiveThread(
              params.client,
              threadId,
              ownership?.release,
            );
            return retained;
          } finally {
            // A full idle pool can reject terminal child ownership. Release
            // its exact branded claim before the monitor forgets that child.
            if (!retained && ownership) {
              await ownership.release(threadId);
            }
            if (childThreadOwnership.get(threadId) === ownership) {
              childThreadOwnership.delete(threadId);
            }
          }
        }),
      releaseChildThread: (threadId) =>
        childThreadTransitions.enqueue(threadId, async () => {
          const ownership = childThreadOwnership.get(threadId);
          if (ownership) {
            await ownership.release(threadId);
            if (childThreadOwnership.get(threadId) === ownership) {
              childThreadOwnership.delete(threadId);
            }
          } else {
            // A bare closeAgent thread id cannot authorize a successor's subscription.
            await releaseCodexAppServerLiveThread(params.client, threadId);
          }
        }),
    });
    monitors.set(params.client, monitor);
  }
  return monitor.registerParent({
    parentThreadId: params.parentThreadId,
    requesterSessionKey: params.requesterSessionKey,
    taskRuntimeScope: params.taskRuntimeScope,
    historyOwner: params.historyOwner,
    agentId: params.agentId,
    claimDirectChild: params.claimDirectChild,
    rejectPendingDirectChild: params.rejectPendingDirectChild,
    onDirectChildAccepted: params.onDirectChildAccepted,
  });
}

class Monitor {
  private readonly observationSourceId = randomUUID();
  private readonly parentStates = new Map<string, ParentState>();
  // Notifications can precede the matching turn/start response. This stays
  // turn-keyed until bindTurn proves its parent owner; do not guess a parent.
  private readonly pendingChildAdmissionEvidence = new Map<
    string,
    NativeChildAdmissionEvidence[]
  >();
  private readonly retiredParentStates = new WeakSet<ParentState>();
  private readonly childStates = new Map<string, ChildState>();
  // Native threads survive completed assignments; task runs and delivery remain per assignment.
  private readonly knownChildren = new Map<string, KnownChild>();
  private readonly childThreadIdsByAgentPath = new Map<string, string>();
  private readonly taskReconciliations = new Map<
    string,
    { candidate: TaskRecoveryCandidate; promise: Promise<void> }
  >();
  private readonly taskReconciliationTimers = new Map<
    string,
    { candidate: TaskRecoveryCandidate; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly threadStatusRevisions = new Map<string, ThreadStatusRevision>();
  private readonly recoveryPollDelaysMs: readonly number[];
  private readonly completionDeliveryRetryDelaysMs: readonly number[];
  private readonly completionDeliveryMaxRetries: number;
  private readonly now: () => number;
  private readonly removeNotificationHandler: () => void;
  private readonly removeCloseHandler: () => void;
  private readonly retainClient?: () => (() => void) | undefined;
  private readonly retainParentThread?: (threadId: string) => (() => void) | undefined;
  private readonly claimChildThread?: (threadId: string) => Promise<unknown>;
  private readonly retainChildThread?: (threadId: string) => Promise<unknown>;
  private readonly releaseChildThread?: (threadId: string) => Promise<unknown>;
  private readonly parentThreadRetentions = new Map<string, () => void>();
  private releaseClientRetention?: () => void;
  private disposed = false;

  constructor(
    private readonly client: NativeSubagentMonitorClient,
    private readonly runtime: NativeSubagentMonitorRuntime = defaultRuntime,
    options: MonitorOptions = {},
  ) {
    this.recoveryPollDelaysMs = options.recoveryPollDelaysMs ?? DEFAULT_RECOVERY_POLL_DELAYS_MS;
    this.completionDeliveryRetryDelaysMs =
      options.completionDeliveryRetryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.completionDeliveryMaxRetries =
      options.completionDeliveryMaxRetries ?? this.completionDeliveryRetryDelaysMs.length;
    this.now = options.now ?? Date.now;
    this.retainClient = options.retainClient;
    this.retainParentThread = options.retainParentThread;
    this.claimChildThread = options.claimChildThread;
    this.retainChildThread = options.retainChildThread;
    this.releaseChildThread = options.releaseChildThread;
    this.removeNotificationHandler = client.addNotificationHandler(async (notification) => {
      if (!NATIVE_SUBAGENT_NOTIFICATION_METHODS.has(notification.method)) {
        return;
      }
      await this.handleNotification(notification);
    });
    this.removeCloseHandler = client.addCloseHandler(() => this.dispose());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeNotificationHandler();
    this.removeCloseHandler();
    for (const { timer } of this.taskReconciliationTimers.values()) {
      clearTimeout(timer);
    }
    this.taskReconciliationTimers.clear();
    for (const childState of this.childStates.values()) {
      if (!childState.terminal && childState.activityObserved) {
        emitAgentEvent({
          runId: childState.runId,
          ...(childState.agentId ? { agentId: childState.agentId } : {}),
          stream: "execution",
          data: { state: "unknown", sourceId: this.observationSourceId, invalidate: true },
        });
      }
      this.releaseDirectChild(childState);
      // Terminal delivery no longer needs app-server. Keep its bounded retry
      // alive if idle-pool eviction closes this client between attempts.
      if (childState.terminal && childState.pendingCompletion) {
        this.clearRecoveryTimers(childState);
        continue;
      }
      this.unregisterChild(childState);
    }
    this.releaseRetainedClient();
    for (const release of this.parentThreadRetentions.values()) {
      release();
    }
    this.parentThreadRetentions.clear();
    for (const state of this.parentStates.values()) {
      state.owners.clear();
      state.turnIds.clear();
      this.deliverDetachedCompletions(state);
    }
    this.pendingChildAdmissionEvidence.clear();
    for (const [parentThreadId] of this.parentStates) {
      if (
        ![...this.childStates.values()].some(
          (childState) => childState.parentThreadId === parentThreadId,
        )
      ) {
        this.parentStates.delete(parentThreadId);
      }
    }
    this.knownChildren.clear();
    this.childThreadIdsByAgentPath.clear();
  }

  registerParent(params: {
    parentThreadId: string;
    requesterSessionKey?: string;
    taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
    historyOwner?: CodexNativeSubagentHistoryOwner;
    agentId?: string;
    claimDirectChild?: (threadId: string) => (() => void) | undefined;
    rejectPendingDirectChild?: (threadId: string, reason: string) => void;
    onDirectChildAccepted?: () => void;
  }): { bindTurn: (turnId: string) => void; unregister: () => void } {
    const parentThreadId = params.parentThreadId.trim();
    if (!parentThreadId) {
      throw new Error("Codex native subagent monitor requires a parent thread id");
    }
    if (this.disposed) {
      throw new Error("Codex native subagent monitor is closed");
    }
    let state = this.parentStates.get(parentThreadId);
    if (
      state?.requesterSessionKey &&
      params.requesterSessionKey &&
      state.requesterSessionKey !== params.requesterSessionKey
    ) {
      throw new Error(`Codex thread ${parentThreadId} is already bound to another session`);
    }
    if (!state) {
      state = {
        parentThreadId,
        owners: new Map(),
        turnIds: new Set(),
        deliveryReceipts: new CodexNativeSubagentDeliveryReceipts(),
      };
      this.parentStates.set(parentThreadId, state);
    }
    state.requesterSessionKey ??= params.requesterSessionKey;
    state.taskRuntimeScope ??= params.taskRuntimeScope;
    state.historyOwner ??= params.historyOwner;
    state.agentId ??= params.agentId;
    const owner = Symbol("codex-native-subagent-owner");
    state.owners.set(owner, {
      claimDirectChild: params.claimDirectChild,
      rejectPendingDirectChild: params.rejectPendingDirectChild,
      onDirectChildAccepted: params.onDirectChildAccepted,
    });
    this.prepareParentTaskRuntime(state);
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId === parentThreadId && childState.pendingCompletion) {
        void this.deliverPendingCompletion(state, childState);
      }
    }
    let registered = true;
    const registeredState = state;
    // Recovery may perform several bounded history reads. It must never delay
    // the foreground parent turn that established this registration.
    void this.reconcileTaskRowsForParent(registeredState).catch((error: unknown) => {
      embeddedAgentLog.warn("Failed to reconcile Codex native subagent task rows", {
        parentThreadId,
        error: formatErrorMessage(error),
      });
    });
    return {
      bindTurn: (turnIdInput) => {
        const turnId = turnIdInput.trim();
        if (!turnId || this.parentStates.get(parentThreadId) !== registeredState) {
          return;
        }
        const current = registeredState.owners.get(owner);
        if (
          !current ||
          [...registeredState.owners.values()].some(
            (other) => other !== current && other.turnId === turnId,
          )
        ) {
          return;
        }
        current.turnId = turnId;
        registeredState.turnIds.add(turnId);
        this.drainPendingChildAdmissionEvidence(registeredState, current, turnId, true);
        this.clearUnconsumablePendingChildAdmissionEvidence();
      },
      unregister: () => {
        if (!registered) {
          return;
        }
        registered = false;
        const current = this.parentStates.get(parentThreadId);
        if (current === registeredState) {
          const turnId = current.owners.get(owner)?.turnId;
          current.owners.delete(owner);
          if (turnId) {
            current.turnIds.delete(turnId);
          }
          if (current.owners.size === 0) {
            current.turnIds.clear();
            // In-flight recovery retains this run's receipts; a later run must
            // not inherit them merely because it reuses an agent path.
            current.deliveryReceipts = new CodexNativeSubagentDeliveryReceipts();
          }
          this.clearUnconsumablePendingChildAdmissionEvidence();
          this.deliverDetachedCompletions(current);
          this.pruneParentIfUnused(current);
        }
      },
    };
  }

  retireParent(parentThreadIdInput: string): void {
    const parentThreadId = parentThreadIdInput.trim();
    const state = this.parentStates.get(parentThreadId);
    if (!state) {
      return;
    }
    // Reset invalidates this exact registration generation. Pending recovery
    // must not recreate its parent or deliver old children into a replacement.
    this.retiredParentStates.add(state);
    state.owners.clear();
    this.clearPendingChildAdmissionEvidenceForParent(parentThreadId);
    for (const childState of Array.from(this.childStates.values())) {
      if (childState.parentThreadId === parentThreadId) {
        this.retireChild(state, childState, "Subagent parent session ended.");
      }
    }
    this.pruneParentIfUnused(state);
  }

  private prepareParentTaskRuntime(state: ParentState): void {
    if (!state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    state.taskRuntime ??= this.runtime.createAgentHarnessTaskRuntime({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      scope: state.taskRuntimeScope,
      runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
      executionPid: this.client.getTransportPid(),
    });
    state.mirror ??= new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: state.parentThreadId,
        requesterSessionKey: state.requesterSessionKey,
        historyOwner: state.historyOwner,
        agentId: state.agentId,
      },
      state.taskRuntime,
    );
  }

  /** Handles one notification from the client-wide router observer. */
  private async handleNotification(notification: CodexServerNotification): Promise<void> {
    if (this.disposed) {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    this.captureUnregisteredChildTurn(notification, params);
    if (
      notification.method === "turn/started" &&
      params &&
      !this.observeNativeChildTurnStart(params)
    ) {
      return;
    }
    if (notification.method === "turn/completed" && params) {
      const known = this.knownChildren.get(readString(params, "threadId") ?? "");
      const turn = isJsonObject(params.turn) ? params.turn : undefined;
      const turnId = readString(turn, "id");
      const pending = known?.pendingTurns.find((candidate) => candidate.turnId === turnId);
      if (pending) {
        pending.state = readNativeTurnEnd(turn);
      }
    }
    const state = this.resolveMirrorState(notification);
    const startedThread = isJsonObject(params?.thread) ? params.thread : undefined;
    const threadId =
      readString(params, "threadId")?.trim() ?? readString(startedThread, "id")?.trim();
    const threadStatus = isJsonObject(params?.status)
      ? normalizeIdentifier(readString(params.status, "type"))
      : undefined;
    const parent = threadId ? this.parentStates.get(threadId) : undefined;
    if (parent && parent.owners.size > 0 && notification.method === "turn/started") {
      const turnId = isJsonObject(params?.turn) ? readString(params.turn, "id") : undefined;
      if (turnId) {
        parent.turnIds.add(turnId);
      }
    }
    const tracksRecoveryRevision = Boolean(threadId && this.threadStatusRevisions.has(threadId));
    if (
      RECOVERY_REVISION_NOTIFICATION_METHODS.has(notification.method) &&
      threadId &&
      tracksRecoveryRevision
    ) {
      this.threadStatusRevisions.get(threadId)!.value += 1;
    }
    if (
      !state &&
      (!threadId ||
        (!this.parentStates.has(threadId) &&
          !this.currentChild(threadId) &&
          !tracksRecoveryRevision))
    ) {
      return;
    }
    const notificationTurnId =
      readString(params, "turnId") ??
      (isJsonObject(params?.turn) ? readString(params.turn, "id") : undefined);
    const pendingTurns = threadId ? this.knownChildren.get(threadId)?.pendingTurns : undefined;
    const pendingNativeTurn = pendingTurns?.some(
      (pending) => !notificationTurnId || pending.turnId === notificationTurnId,
    );
    if (pendingNativeTurn && threadId) {
      const previous = this.currentChild(threadId);
      if (previous) {
        void this.reconcileRegisteredChild(previous).catch((error: unknown) => {
          this.logRecoveryFailure(threadId, error);
          this.scheduleRecoveryPoll(previous);
        });
      }
    }
    if (state?.mirror && !pendingNativeTurn) {
      try {
        state.mirror.handleNotification(notification);
      } catch (error) {
        embeddedAgentLog.warn("Failed to mirror Codex native subagent lifecycle event", {
          method: notification.method,
          error: formatErrorMessage(error),
        });
      }
    }
    if (state) {
      this.handleClosedChild(notification, state);
    }
    const childState = threadId && !pendingNativeTurn ? this.currentChild(threadId) : undefined;
    if (notification.method === "turn/started" && childState) {
      childState.nativeCompletionDelivered = false;
      this.resumeChild(childState);
    }
    if (parent && parent.turnIds.has(readString(params, "turnId") ?? "")) {
      this.recordNativeCompletionDelivery(parent, notification);
    }
    if (
      childState &&
      !childState.terminal &&
      (!pendingTurns?.length || notification.method === "turn/completed")
    ) {
      this.emitChildTaskActivity(notification, childState);
    }
    if (!pendingNativeTurn) {
      this.captureChildAssistantMessage(notification);
      await this.handleChildTurnCompletion(notification, childState);
    }
    if (
      !pendingNativeTurn &&
      notification.method === "thread/status/changed" &&
      threadId &&
      threadStatus
    ) {
      if (threadStatus !== "systemerror") {
        if (childState) {
          this.clearSystemErrorFallback(childState);
        }
      } else {
        if (childState) {
          this.resumeChild(childState, { scheduleRecovery: false });
          this.setRecoveryFallback(
            childState,
            systemErrorFallbackCompletion(childState.childThreadId),
            this.now(),
          );
        }
        void this.reconcileChildThread(threadId)
          .catch((error: unknown) => {
            this.logRecoveryFailure(threadId, error);
            return false;
          })
          .then((reconciled) => {
            if (!reconciled && childState && this.currentChild(threadId) === childState) {
              this.scheduleRecoveryPoll(childState);
            }
          });
      }
    }
    await this.handleCompletionNotification(notification);
  }

  private emitChildTaskActivity(
    notification: CodexServerNotification,
    childState: ChildState,
  ): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    const owner = {
      runId: childState.runId,
      ...(childState.agentId ? { agentId: childState.agentId } : {}),
    };
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    const turnId = readString(params, "turnId") ?? readString(turn, "id");
    if (notification.method === "turn/started") {
      childState.nativeTurnId = turnId;
      childState.nativeTurnState = "active";
      childState.activityWait = undefined;
    } else if (turnId && childState.nativeTurnId && turnId !== childState.nativeTurnId) {
      return;
    } else if (turnId && childState.nativeTurnState && childState.nativeTurnState !== "active") {
      return;
    } else if (turnId) {
      childState.nativeTurnId ??= turnId;
    }
    const observe = (state: "running" | "waiting" | "unknown", wait?: NativeExecutionWait) => {
      childState.activityObserved = true;
      emitAgentEvent({
        ...owner,
        stream: "execution",
        data: {
          state,
          sourceId: this.observationSourceId,
          ...(childState.nativeTurnId ? { executionId: childState.nativeTurnId } : {}),
          ...(wait ? { wait } : {}),
        },
      });
    };
    if (notification.method === "turn/started") {
      observe("running");
      return;
    }
    if (notification.method === "turn/completed") {
      childState.nativeTurnState = readNativeTurnEnd(turn);
      childState.activityWait = undefined;
      // Ending a native turn does not settle its task. The completion owner
      // still resolves the result, and interrupted children can receive input.
      observe("unknown");
      if (childState.nativeTurnState) {
        this.releaseDirectChild(childState);
      }
      const state = this.parentStates.get(childState.parentThreadId);
      const current = state ? this.recordObservedChildTurn(state, childState) : undefined;
      if (current?.nativeTurnId !== turnId && current?.nativeTurnState === "active") {
        this.emitChildTaskActivity(
          {
            method: "turn/started",
            params: { threadId: current.childThreadId, turn: { id: current.nativeTurnId! } },
          },
          current,
        );
      }
      return;
    }
    if (notification.method === "thread/status/changed") {
      const status = isJsonObject(params.status) ? params.status : undefined;
      if (status?.type === "active") {
        const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
        const wait: NativeExecutionWait | undefined = flags.includes("waitingOnApproval")
          ? { kind: "approval" }
          : flags.includes("waitingOnUserInput")
            ? { kind: "user_input" }
            : childState.activityWait?.wait;
        observe(wait ? "waiting" : "running", wait);
      } else if (
        status?.type === "idle" ||
        status?.type === "notLoaded" ||
        status?.type === "systemError"
      ) {
        childState.activityWait = undefined;
        observe("unknown");
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const delta = readString(params, "delta");
      if (delta) {
        if (!childState.activityObserved) {
          observe("running");
        }
        emitAgentEvent({ ...owner, stream: "assistant", data: { delta } });
      }
      return;
    }
    if (notification.method === "item/reasoning/summaryTextDelta") {
      const delta = readString(params, "delta");
      if (delta) {
        if (!childState.activityObserved) {
          observe("running");
        }
        emitAgentEvent({ ...owner, stream: "thinking", data: { delta } });
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const item = readItem(params.item);
    if (
      item?.type === "collabAgentToolCall" &&
      normalizeIdentifier(item.tool ?? undefined) === "wait" &&
      Array.isArray(item.receiverThreadIds)
    ) {
      if (notification.method === "item/started") {
        const receivers = [
          ...new Set(
            item.receiverThreadIds.flatMap((id) =>
              typeof id === "string" && id.trim() ? [id.trim()] : [],
            ),
          ),
        ];
        // V2 has no target IDs; V1 exposes its selected children explicitly.
        const wait: NativeExecutionWait =
          receivers.length > 0
            ? {
                kind: "children",
                dependencies: receivers.slice(0, 32).map((id) => {
                  const receiver = this.knownChildren.get(id);
                  return {
                    runId:
                      receiver?.parent.parentThreadId === childState.parentThreadId
                        ? receiver.assignment.runId
                        : codexNativeSubagentRunId(id),
                  };
                }),
                pendingCount: receivers.length,
              }
            : { kind: "agent_messages" };
        childState.activityWait = { itemId: item.id, wait };
        observe("waiting", wait);
      } else if (childState.activityWait?.itemId === item.id) {
        childState.activityWait = undefined;
        observe("running");
      }
      return;
    }
    if (item?.type === "agentMessage" && notification.method === "item/completed" && item.text) {
      if (!childState.activityObserved) {
        observe("running");
      }
      emitAgentEvent({ ...owner, stream: "assistant", data: { text: item.text } });
    }
    const projection = projectNormalizedToolItem({
      phase: notification.method === "item/started" ? "start" : "result",
      item,
    });
    if (projection?.event) {
      if (!childState.activityObserved) {
        observe("running");
      }
      emitAgentEvent({ ...owner, ...projection.event });
    }
  }

  private resumeChild(childState: ChildState, options: { scheduleRecovery?: boolean } = {}): void {
    if (childState.terminal) {
      return;
    }
    this.observeActiveChild(childState);
    this.clearRecoveryTimers(childState);
    childState.recoveryAttempt = 0;
    if (options.scheduleRecovery !== false) {
      this.scheduleRecoveryPoll(childState);
    }
  }

  private observeActiveChild(childState: ChildState): void {
    childState.settledWithoutCompletion = false;
    childState.fallbackCompletion = undefined;
    this.releaseClientRetention ??= this.retainClient?.();
  }

  private settleResumableChild(childState: ChildState): void {
    if (childState.terminal) {
      return;
    }
    childState.settledWithoutCompletion = true;
    childState.fallbackCompletion = undefined;
    this.releaseDirectChild(childState);
    this.clearRecoveryTimers(childState);
    this.releaseClientRetentionIfIdle();
  }

  private captureChildAssistantMessage(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const childState = childThreadId ? this.currentChild(childThreadId) : undefined;
    if (!childState || childState.terminal) {
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const turnId = readString(params, "turnId");
      const itemId = readString(params, "itemId");
      const delta = readString(params, "delta");
      if (turnId && itemId && delta) {
        this.recordChildAssistantMessage(childState, turnId, itemId, delta);
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    this.captureChildAssistantMessageItem(
      childState,
      readString(params, "turnId"),
      isJsonObject(params?.item) ? params.item : undefined,
    );
  }

  private captureChildAssistantMessageItem(
    childState: ChildState,
    turnId: string | undefined,
    item: JsonObject | undefined,
  ): void {
    if (readString(item, "type") !== "agentMessage" || !turnId) {
      return;
    }
    const itemId = readString(item, "id");
    if (!itemId) {
      return;
    }
    const messages = this.getChildAssistantMessages(childState, turnId);
    const phase = readString(item, "phase");
    if (phase === "commentary") {
      messages.commentaryIds.add(itemId);
    } else {
      messages.finalMessageIds.add(itemId);
    }
    const text = readString(item, "text");
    if (text) {
      this.recordChildAssistantMessage(childState, turnId, itemId, text, { replace: true });
    }
  }

  private captureChildTurnAssistantMessages(childState: ChildState, turn: JsonObject): void {
    const turnId = readString(turn, "id");
    if (!turnId || !Array.isArray(turn.items)) {
      return;
    }
    for (const item of turn.items) {
      this.captureChildAssistantMessageItem(
        childState,
        turnId,
        isJsonObject(item) ? item : undefined,
      );
    }
  }

  private recordChildAssistantMessage(
    childState: ChildState,
    turnId: string,
    itemId: string,
    text: string,
    options: { replace?: boolean } = {},
  ): void {
    const messages = this.getChildAssistantMessages(childState, turnId);
    if (!messages.texts.has(itemId)) {
      messages.order.push(itemId);
    }
    const existing = messages.texts.get(itemId) ?? "";
    messages.texts.set(itemId, options.replace ? text : `${existing}${text}`);
  }

  private getChildAssistantMessages(
    childState: ChildState,
    turnId: string,
  ): ChildAssistantMessages {
    let messages = childState.assistantMessagesByTurn.get(turnId);
    if (!messages) {
      messages = {
        texts: new Map<string, string>(),
        order: [],
        commentaryIds: new Set<string>(),
        finalMessageIds: new Set<string>(),
      };
      childState.assistantMessagesByTurn.set(turnId, messages);
    }
    return messages;
  }

  private async handleChildTurnCompletion(
    notification: CodexServerNotification,
    childState: ChildState | undefined,
  ): Promise<void> {
    if (notification.method !== "turn/completed") {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    const turn = isJsonObject(params?.turn) ? params.turn : undefined;
    if (
      !state ||
      !childState ||
      childState.childThreadId !== childThreadId ||
      !turn ||
      childState.terminal
    ) {
      return;
    }
    const turnId = readString(turn, "id");
    if (childState.nativeTurnId && turnId !== childState.nativeTurnId) {
      return;
    }
    const status = normalizeIdentifier(readString(turn, "status"));
    if (status === "interrupted") {
      this.removePendingSpawnAdmissionEvidenceForChild(childState.childThreadId);
      this.rejectPendingDirectChild(
        state,
        childState.childThreadId,
        "Codex child turn interrupted",
      );
      if (turnId) {
        childState.assistantMessagesByTurn.delete(turnId);
      }
      this.settleResumableChild(childState);
      return;
    }
    if (status === "completed" || status === "failed") {
      // Completion text may require history recovery, but a terminal child no
      // longer owns executable parent authority while that observation runs.
      const latestTurnId = this.knownChildren.get(childState.childThreadId)?.turnId;
      if (!latestTurnId || latestTurnId === turnId) {
        const revision = this.threadStatusRevisions.get(childState.childThreadId);
        if (revision) {
          revision.terminal = true;
        }
        this.rejectPendingDirectChild(
          state,
          childState.childThreadId,
          "Codex child turn completed",
        );
        this.removePendingSpawnAdmissionEvidenceForChild(childState.childThreadId);
      }
      this.releaseDirectChild(childState);
    }
    this.captureChildTurnAssistantMessages(childState, turn);
    const completion = toChildTurnCompletion(childState, turn);
    if (!completion) {
      return;
    }
    await this.processObservedCompletion(state, childState, completion);
  }

  /** Reads one child through app-server history and delivers a terminal result when present. */
  async reconcileChildThread(childThreadIdInput: string): Promise<boolean> {
    const childState = this.currentChild(childThreadIdInput.trim());
    return childState ? this.reconcileRegisteredChild(childState) : false;
  }

  private async reconcileRegisteredChild(childState: ChildState): Promise<boolean> {
    if (
      childState.terminal ||
      this.disposed ||
      this.childStates.get(childState.runId) !== childState
    ) {
      return false;
    }
    if (childState.recoveryInFlight) {
      return await childState.recoveryInFlight;
    }
    const recovery = this.reconcileChildState(childState);
    childState.recoveryInFlight = recovery;
    try {
      return await recovery;
    } finally {
      if (childState.recoveryInFlight === recovery) {
        childState.recoveryInFlight = undefined;
      }
    }
  }

  private resolveMirrorState(notification: CodexServerNotification): ParentState | undefined {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return undefined;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const parentThreadId = readThreadParentThreadId(thread);
      const childThreadId = thread ? readString(thread, "id")?.trim() : undefined;
      const agentPath = readString(readThreadSpawnSource(thread), "agent_path")?.trim();
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && childThreadId && parentThreadId) {
        return this.registerChildThread(
          state,
          childThreadId,
          agentPath === undefined ? {} : { agentPath },
        )
          ? state
          : undefined;
      }
      return state;
    }
    if (
      notification.method === "thread/status/changed" ||
      notification.method === "turn/started" ||
      notification.method === "turn/completed" ||
      notification.method === "item/agentMessage/delta"
    ) {
      const childThreadId = readString(params, "threadId")?.trim();
      const parentThreadId = childThreadId
        ? this.currentChild(childThreadId)?.parentThreadId
        : undefined;
      return parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const parentThreadId = item
        ? (readString(item, "senderThreadId") ?? readString(params, "threadId"))?.trim()
        : undefined;
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && parentThreadId) {
        const turnId = readString(params, "turnId");
        const owner = this.resolveParentOwner(state, turnId);
        if (notification.method === "item/completed") {
          if (
            readString(item, "type") === "subAgentActivity" &&
            readString(item, "kind") === "interacted"
          ) {
            const childThreadId = readString(item, "agentThreadId");
            if (childThreadId) {
              this.observeParentInteraction(
                state,
                owner,
                childThreadId,
                readString(item, "agentPath"),
                { parentTurnId: turnId, itemId: readString(item, "id") },
              );
            }
            return state;
          }
          if (
            readString(item, "type") === "collabAgentToolCall" &&
            readString(item, "tool") === "sendInput" &&
            readString(item, "status") === "completed"
          ) {
            for (const childThreadId of readStringArray(item?.receiverThreadIds)) {
              this.observeParentInteraction(state, owner, childThreadId, undefined, {
                parentTurnId: turnId,
                itemId: readString(item, "id"),
              });
            }
          }
        }
        // Codex multi-agent V2 exposes the child only through this parent-scoped
        // activity item; its later wait item has no receiver thread ids.
        if (
          notification.method === "item/completed" &&
          readString(item, "type") === "subAgentActivity" &&
          normalizeIdentifier(readString(item, "kind")) === "started"
        ) {
          const childThreadId = readString(item, "agentThreadId")?.trim();
          const agentPath = readString(item, "agentPath");
          if (childThreadId) {
            this.registerDirectSpawnChild(
              state,
              turnId,
              {
                parentThreadId,
                childThreadId,
                ...(agentPath === undefined ? {} : { agentPath }),
              },
              owner,
            );
          }
          return state;
        }
        const isCompletedSpawnAgentTool =
          notification.method === "item/completed" &&
          readString(item, "type") === "collabAgentToolCall" &&
          normalizeIdentifier(readString(item, "tool")) === "spawnagent" &&
          normalizeIdentifier(readString(item, "status")) === "completed";
        if (normalizeIdentifier(readString(item, "tool")) === "closeagent") {
          // closeAgent names an existing child before shutdown; treating its
          // receiver as discovery resurrects completed tasks and repins parents.
          return state;
        }
        // Pinned Codex derives both fields from the spawn ID, but agentsStates is
        // observational status metadata. Only receiverThreadIds is authoritative
        // direct-spawn evidence and may mint retained child authority.
        const childThreadIds = new Set(readStringArray(item?.receiverThreadIds));
        let accepted = true;
        for (const childThreadId of childThreadIds) {
          accepted =
            Boolean(
              isCompletedSpawnAgentTool
                ? this.registerDirectSpawnChild(
                    state,
                    turnId,
                    { parentThreadId, childThreadId },
                    owner,
                  )
                : this.registerChildThread(state, childThreadId),
            ) && accepted;
        }
        if (!accepted) {
          return undefined;
        }
      }
      return state;
    }
    return undefined;
  }

  private handleClosedChild(notification: CodexServerNotification, state: ParentState): void {
    if (notification.method !== "item/completed") {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const item = isJsonObject(params?.item) ? params.item : undefined;
    if (
      readString(item, "type") !== "collabAgentToolCall" ||
      normalizeIdentifier(readString(item, "tool")) !== "closeagent" ||
      normalizeIdentifier(readString(item, "status")) !== "completed"
    ) {
      return;
    }
    const childThreadIds = new Set([
      ...readStringArray(item?.receiverThreadIds),
      ...readObjectStringKeys(item?.agentsStates),
    ]);
    for (const childThreadId of childThreadIds) {
      const childState = this.currentChild(childThreadId);
      if (childState && childState.parentThreadId !== state.parentThreadId) {
        continue;
      }
      if (childState) {
        this.retireChild(state, childState, "Subagent was closed.");
      } else {
        this.updateChildThreadOwnership("release", childThreadId, this.releaseChildThread);
      }
    }
  }

  private retireChild(state: ParentState, childState: ChildState, summary: string): void {
    if (
      childState.pendingCompletion &&
      childState.completionTaskPhase &&
      !this.retiredParentStates.has(state)
    ) {
      // Closing the native child does not discard its already accepted result.
      // Persistence keeps its owner, but must not warm a closed subscription later.
      childState.subscriptionClosed = true;
      this.releaseDirectChild(childState);
      this.clearRecoveryTimers(childState);
      this.updateChildThreadOwnership("release", childState.childThreadId, this.releaseChildThread);
      this.releaseClientRetentionIfIdle();
      return;
    }
    if (!childState.terminal) {
      childState.terminal = true;
      const known = this.knownChildren.get(childState.childThreadId);
      if (known?.assignment.runId === childState.runId) {
        known.assignment.terminal = true;
        known.assignment.nativeTurnId = childState.nativeTurnId;
      }
      const revision = this.threadStatusRevisions.get(childState.childThreadId);
      if (revision) {
        revision.terminal = true;
      }
      const eventAt = this.now();
      state.mirror?.markAuthoritativeCompletion(childState.childThreadId);
      state.taskRuntime?.finalizeTaskRunByRunId({
        runId: childState.runId,
        status: "cancelled",
        endedAt: eventAt,
        lastEventAt: eventAt,
        error: summary,
        progressSummary: summary,
        terminalSummary: summary,
      });
    }
    if (childState.pendingCompletion) {
      childState.pendingCompletion = undefined;
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: childState.runId,
        deliveryStatus: "failed",
        error: summary,
      });
    }
    this.unregisterChild(childState, { retainSubscription: false });
    this.updateChildThreadOwnership("release", childState.childThreadId, this.releaseChildThread);
  }

  private async handleCompletionNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const parentThreadId = params ? readString(params, "threadId")?.trim() : undefined;
    const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    if (!state) {
      return;
    }
    for (const nativeCompletion of nativeSubagentNotifications.fromNotification(notification)) {
      const childThreadId = this.childThreadIdsByAgentPath.get(
        buildParentAgentPathKey(state.parentThreadId, nativeCompletion.agentPath),
      );
      const childState = childThreadId ? this.currentChild(childThreadId) : undefined;
      if (
        !childState ||
        childState.parentThreadId !== state.parentThreadId ||
        childState.terminal ||
        this.knownChildren.get(childState.childThreadId)?.pendingTurns.length ||
        readCodexNativeSubagentRunId(childState.runId)?.turnId
      ) {
        embeddedAgentLog.warn(
          "Ignoring Codex native subagent completion for unknown child thread",
          {
            parentThreadId: state.parentThreadId,
            agentPath: nativeCompletion.agentPath,
          },
        );
        continue;
      }
      const completion: CodexNativeSubagentCompletion = {
        childThreadId: childState.childThreadId,
        status: nativeCompletion.status,
        statusLabel: nativeCompletion.statusLabel,
        result: nativeCompletion.result,
      };
      await this.processObservedCompletion(state, childState, completion);
    }
  }

  private async processObservedCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
  ): Promise<void> {
    if (!isNoFinalCompletion(completion)) {
      await this.processCompletion(state, childState, completion);
      return;
    }
    this.resumeChild(childState, { scheduleRecovery: false });
    this.setRecoveryFallback(childState, completion, this.now());
    await this.reconcileRegisteredChild(childState).catch((error: unknown) => {
      this.logRecoveryFailure(childState.childThreadId, error);
      return false;
    });
  }

  private async reconcileChildState(childState: ChildState): Promise<boolean> {
    const state = this.parentStates.get(childState.parentThreadId);
    if (!state) {
      return false;
    }
    const statusRead = this.retainThreadStatusRevision(childState.childThreadId);
    try {
      const recovery = await this.readThreadRecovery(childState, {
        resumeInterrupted: !childState.terminal,
        recordedCompletion: childState.pendingCompletion,
      });
      // Notification handlers run concurrently. A later status transition wins
      // over this read so stale history cannot complete or re-arm the child.
      if (!statusRead.isCurrent() || this.childStates.get(childState.runId) !== childState) {
        return false;
      }
      if (recovery.parentThreadId && recovery.parentThreadId !== childState.parentThreadId) {
        embeddedAgentLog.warn("Codex native subagent parent did not match monitor state", {
          childThreadId: childState.childThreadId,
          expectedParentThreadId: childState.parentThreadId,
          actualParentThreadId: recovery.parentThreadId,
        });
        this.unregisterChild(childState);
        return false;
      }
      if (recovery.agentPath) {
        this.registerAgentPath(state, childState.childThreadId, recovery.agentPath);
      }
      this.recordRecoveredChildTurn(state, childState, recovery);
      if (recovery.threadState === "active") {
        this.observeActiveChild(childState);
        return false;
      }
      if (recovery.threadState === "other") {
        this.clearSystemErrorFallback(childState);
      }
      if (recovery.resumable) {
        this.settleResumableChild(childState);
        return false;
      }
      const completion = recovery.completion;
      if (!completion) {
        if (recovery.fallbackCompletion) {
          this.setRecoveryFallback(
            childState,
            recovery.fallbackCompletion,
            recovery.fallbackCompletion.completedAt ?? this.now(),
          );
        }
        return false;
      }
      if (isNoFinalCompletion(completion)) {
        this.setRecoveryFallback(childState, completion, completion.completedAt ?? this.now());
        return false;
      }
      await this.processCompletion(state, childState, completion, completion.completedAt);
      return true;
    } finally {
      statusRead.release();
    }
  }

  private requestThreadRead(childThreadId: string, includeTurns: boolean) {
    return this.client.request(
      "thread/read",
      {
        threadId: childThreadId,
        includeTurns,
      },
      {
        timeoutMs: THREAD_READ_TIMEOUT_MS,
      },
    );
  }

  private requestLatestThreadTurn(childThreadId: string) {
    return this.client.request(
      "thread/turns/list",
      {
        threadId: childThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      },
      { timeoutMs: THREAD_READ_TIMEOUT_MS },
    );
  }

  private async readThreadRecovery(
    assignment: NativeSubagentAssignment,
    options: {
      resumeInterrupted: boolean;
      recordedCompletion?: RecoveredCompletion;
      observedTurns?: readonly NativeTurnObservation[];
    },
  ): Promise<ThreadRecovery> {
    const { childThreadId } = assignment;
    const { recordedCompletion } = options;
    // Fresh threads can expose lineage before includeTurns history is materialized.
    // Register that lineage now so the normal child backoff owns later full reads.
    const response = await this.requestThreadRead(childThreadId, true).catch(() =>
      this.requestThreadRead(childThreadId, false),
    );
    const thread = isJsonObject(response.thread) ? response.thread : undefined;
    if (!thread || readString(thread, "id")?.trim() !== childThreadId) {
      return { resumable: false, threadState: "unavailable", observedPendingTurns: [] };
    }
    const firstObserved = options.observedTurns?.[0];
    // Forked history can begin with copied parent turns. Only a native child
    // end observed before successor starts can anchor an unlocated predecessor.
    const observedPredecessor =
      options.resumeInterrupted &&
      firstObserved?.state &&
      firstObserved.state !== "active" &&
      !firstObserved.startObserved
        ? firstObserved.turnId
        : undefined;
    const turnId = assignment.nativeTurnId ?? observedPredecessor;
    const pendingTurnIds = new Set([
      ...(this.knownChildren.get(childThreadId)?.pendingTurns.map((pending) => pending.turnId) ??
        []),
      ...(options.observedTurns?.map((turn) => turn.turnId) ?? []),
    ]);
    const unresolvedAssignment = options.resumeInterrupted && !turnId && pendingTurnIds.size > 0;
    const observedPendingTurns: ThreadRecovery["observedPendingTurns"] = [];
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      const pendingTurnId = readString(turn, "id");
      if (pendingTurnId && pendingTurnIds.has(pendingTurnId)) {
        observedPendingTurns.push({ turnId: pendingTurnId, state: readNativeTurnState(turn) });
      }
    }
    const threadStatus = isJsonObject(thread.status)
      ? normalizeIdentifier(readString(thread.status, "type"))
      : undefined;
    let completion: RecoveredCompletion | undefined;
    let fallbackCompletion: RecoveredCompletion | undefined;
    let nativeTurnId: string | undefined;
    let nativeTurnState: NativeTurnState | undefined;
    let resumable = false;
    let threadState: ThreadRecovery["threadState"] =
      threadStatus === "active"
        ? "active"
        : threadStatus === "systemerror"
          ? "system_error"
          : threadStatus
            ? "other"
            : "unavailable";
    if (unresolvedAssignment) {
      threadState = "unavailable";
    } else if (turnId) {
      const turns = Array.isArray(thread.turns) ? thread.turns.filter(isJsonObject) : [];
      let index = turns.findIndex((turn) => readString(turn, "id") === turnId);
      // A missed resume notification can leave an unfinished assignment on an
      // interrupted turn. Stop at its first terminal turn, before any later assignment.
      while (
        options.resumeInterrupted &&
        index >= 0 &&
        index + 1 < turns.length &&
        normalizeIdentifier(readString(turns[index], "status")) === "interrupted"
      ) {
        index += 1;
      }
      const turn = turns[index];
      const turnStatus = normalizeIdentifier(readString(turn, "status"));
      nativeTurnId = readString(turn, "id");
      nativeTurnState = readNativeTurnState(turn);
      completion = isJsonObject(turn) ? readTurnCompletion(turn, childThreadId) : undefined;
      resumable = turnStatus === "interrupted";
      threadState = turnStatus === "inprogress" ? "active" : turnStatus ? "other" : "unavailable";
    } else if (threadStatus === "active") {
      const turn = Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
      if (normalizeIdentifier(readString(turn, "status")) === "inprogress") {
        nativeTurnId = readString(turn, "id");
        nativeTurnState = "active";
      }
    } else if (threadStatus !== "systemerror") {
      const turnRecovery = readThreadTurnRecovery(thread, childThreadId);
      nativeTurnId = turnRecovery.nativeTurnId;
      nativeTurnState = turnRecovery.nativeTurnState;
      completion = turnRecovery.completion;
      resumable = turnRecovery.resumable;
    }
    if (
      !unresolvedAssignment &&
      threadStatus === "systemerror" &&
      (!turnId || (threadState === "unavailable" && !completion))
    ) {
      // The pinned protocol's paged history distinguishes the failed current
      // turn from earlier persisted results.
      const turnsResponse = await this.requestLatestThreadTurn(childThreadId).catch(
        () => undefined,
      );
      const data =
        isJsonObject(turnsResponse) && Array.isArray(turnsResponse.data) ? turnsResponse.data : [];
      const latestTurn = isJsonObject(data[0]) ? data[0] : undefined;
      const latestTurnId = readString(latestTurn, "id");
      if (latestTurnId && pendingTurnIds.has(latestTurnId)) {
        observedPendingTurns.push({ turnId: latestTurnId, state: readNativeTurnState(latestTurn) });
      }
      const latestTurnStatus = normalizeIdentifier(readString(latestTurn, "status"));
      const matchesAssignment = !turnId || readString(latestTurn, "id") === turnId;
      if (latestTurn && matchesAssignment) {
        if (turnId) {
          const turnRecovery = readThreadTurnRecovery({ turns: [latestTurn] }, childThreadId);
          nativeTurnId = turnRecovery.nativeTurnId;
          nativeTurnState = turnRecovery.nativeTurnState;
          completion = turnRecovery.completion;
          resumable = turnRecovery.resumable;
        } else if (latestTurnStatus === "failed") {
          completion = readTurnCompletion(latestTurn, childThreadId);
        }
      }
      const known = this.knownChildren.get(childThreadId);
      const taskRecords = !latestTurn ? (known?.parent.taskRuntime?.listTaskRecords() ?? []) : [];
      const task = taskRecords.find((record) => record.runId === assignment.runId);
      // A delivered successor can outlive its monitor state. Its task row still
      // prevents a thread-wide error from being assigned to an older pending result.
      const hasSuccessor =
        task &&
        taskRecords.some(
          (record) =>
            record.requesterSessionKey === task.requesterSessionKey &&
            (record.startedAt ?? record.createdAt) > (task.startedAt ?? task.createdAt) &&
            readNativeTaskAssignment(record)?.childThreadId === childThreadId,
        );
      const unresolvedCurrentAssignment =
        known?.assignment.runId === assignment.runId &&
        this.currentChild(childThreadId)?.nativeTurnState !== "completed" &&
        !hasSuccessor;
      if (latestTurnStatus === "inprogress" && matchesAssignment) {
        nativeTurnId = readString(latestTurn, "id");
        nativeTurnState = "active";
        threadState = "active";
      } else if (
        !completion &&
        !resumable &&
        latestTurnStatus !== "inprogress" &&
        (!turnId || (!latestTurn && unresolvedCurrentAssignment))
      ) {
        // A missing live snapshot must still settle: retry briefly, then report
        // the current assignment's error without failing an older pending result.
        fallbackCompletion = systemErrorFallbackCompletion(childThreadId);
      }
    }
    if (
      recordedCompletion &&
      (!turnId || !completion || completion.status !== recordedCompletion.status)
    ) {
      completion = recordedCompletion;
      if (!turnId) {
        nativeTurnId = undefined;
        nativeTurnState = undefined;
      }
      fallbackCompletion = undefined;
      resumable = false;
      threadState = "other";
    }
    return {
      parentThreadId: readThreadParentThreadId(thread),
      agentPath: normalizeOptionalString(readString(readThreadSpawnSource(thread), "agent_path")),
      assignmentTurnId: turnId,
      nativeTurnId,
      nativeTurnState,
      observedPendingTurns,
      completion,
      fallbackCompletion,
      resumable,
      threadState,
    };
  }

  private recordRecoveredChildTurn(
    state: ParentState,
    child: ChildState,
    recovery: ThreadRecovery,
  ): void {
    const known = this.knownChildren.get(child.childThreadId);
    if (known?.parent === state) {
      for (const observed of recovery.observedPendingTurns) {
        const pending = known.pendingTurns.find(
          (candidate) => candidate.turnId === observed.turnId,
        );
        if (pending && observed.state) {
          pending.state =
            observed.state === "active" && pending !== known.pendingTurns.at(-1)
              ? undefined
              : observed.state;
        }
      }
    }
    const turnId = recovery.nativeTurnId;
    if (!turnId) {
      return;
    }
    const observedTurn = Boolean(child.nativeTurnId && child.nativeTurnId !== turnId);
    if (child.nativeTurnId !== turnId) {
      child.nativeTurnId = turnId;
      child.nativeTurnState = undefined;
      child.activityWait = undefined;
      state.mirror?.recordNativeTurn(child.runId, turnId);
    }
    child.nativeTurnState = recovery.nativeTurnState;
    if (child.nativeTurnState && child.nativeTurnState !== "active") {
      this.releaseDirectChild(child);
    }
    this.recordObservedChildTurn(state, child, observedTurn);
  }

  private recordObservedChildTurn(
    state: ParentState,
    child: ChildState,
    observedTurn = false,
  ): ChildState | undefined {
    const known = this.knownChildren.get(child.childThreadId);
    if (!child.nativeTurnId || known?.parent !== state || known.assignment.runId !== child.runId) {
      return child;
    }
    known.assignment.nativeTurnId = child.nativeTurnId;
    known.assignment.unanchored = undefined;
    if (!known.observedTurns.has(child.nativeTurnId)) {
      known.observedTurns.set(
        child.nativeTurnId,
        observedTurn ? { awaitingInteraction: true } : {},
      );
    }
    if (observedTurn && known.pendingTurns.length === 0) {
      this.associatePendingChildInteraction(known, child.childThreadId, child.nativeTurnId);
    }
    return this.admitFollowupChild(known, child.childThreadId);
  }

  private async processCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number = this.now(),
  ): Promise<void> {
    if (childState.terminal) {
      return;
    }
    childState.terminal = true;
    const known = this.knownChildren.get(childState.childThreadId);
    if (known?.assignment.runId === childState.runId) {
      known.assignment.terminal = true;
      known.assignment.unanchored = undefined;
      known.assignment.nativeTurnId = childState.nativeTurnId;
    }
    childState.pendingCompletion = { ...completion, completedAt: eventAt };
    childState.completionTaskPhase = "finalize";
    const revision = this.threadStatusRevisions.get(childState.childThreadId);
    if (revision) {
      revision.terminal = true;
    }
    this.releaseDirectChild(childState);
    this.clearRecoveryTimers(childState);
    state.mirror?.markAuthoritativeCompletion(completion.childThreadId, childState.runId);
    this.applyNativeReceipts(
      state,
      childState.deliveryReceipts.record(
        childState.runId,
        this.knownChildren.get(childState.childThreadId)?.agentPaths ?? [childState.childThreadId],
        completion.result,
      ),
    );
    await this.deliverPendingCompletion(state, childState);
  }

  private persistPendingCompletion(state: ParentState, child: ChildState): boolean {
    const completion = child.pendingCompletion;
    if (!completion) {
      return false;
    }
    const runId = child.runId;
    if (
      child.completionTaskId &&
      state.taskRuntime?.listTaskRecords().find((task) => task.runId === runId)?.taskId !==
        child.completionTaskId
    ) {
      this.unregisterChild(child);
      return false;
    }
    if (child.completionTaskPhase === "finalize") {
      if (!this.claimCompletionDelivery(state, child)) {
        this.unregisterChild(child);
        return false;
      }
      const eventAt = completion.completedAt ?? this.now();
      const currentRecord = state.taskRuntime
        ?.listTaskRecords()
        .find((record) => record.runId === runId);
      const updated = state.taskRuntime?.finalizeTaskRunByRunId({
        runId,
        status: completion.status,
        endedAt: eventAt,
        lastEventAt: eventAt,
        ...(completion.status === "succeeded" ? {} : { error: completion.result }),
        progressSummary: completion.result,
        terminalSummary: completion.result,
        ...(child.nativeTurnId
          ? {
              detail: {
                ...(isJsonObject(currentRecord?.detail) ? currentRecord.detail : {}),
                nativeTurnId: child.nativeTurnId,
              },
            }
          : {}),
      });
      if (
        state.taskRuntime &&
        !updated?.some(
          (task) =>
            task.runId === runId &&
            (!child.completionTaskId || task.taskId === child.completionTaskId),
        )
      ) {
        const current = state.taskRuntime.listTaskRecords().find((task) => task.runId === runId);
        // Recovery can rewrite an already-terminal outcome still awaiting delivery.
        // Only absence or a conflicting terminal decision retires this projection.
        if (
          !current ||
          (current.status !== completion.status &&
            current.status !== "queued" &&
            current.status !== "running")
        ) {
          this.unregisterChild(child);
          return false;
        }
        throw new Error("Codex native subagent task finalization was not persisted.");
      }
      child.completionTaskPhase = "delivery";
    }
    if (!state.requesterSessionKey || !state.taskRuntimeScope) {
      this.unregisterChild(child);
      return false;
    }
    if (child.completionTaskPhase === "delivery") {
      const updated = state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId,
        deliveryStatus: child.nativeCompletionDelivered ? "delivered" : "pending",
      });
      if (
        state.taskRuntime &&
        !updated?.some(
          (task) =>
            task.runId === runId &&
            (!child.completionTaskId || task.taskId === child.completionTaskId),
        )
      ) {
        if (!state.taskRuntime.listTaskRecords().some((task) => task.runId === runId)) {
          this.unregisterChild(child);
          return false;
        }
        throw new Error("Codex native subagent task delivery status was not persisted.");
      }
      child.completionTaskPhase = undefined;
      child.completionDeliveryAttempt = 0;
    }
    if (child.nativeCompletionDelivered) {
      child.pendingCompletion = undefined;
      this.unregisterChild(child);
      return false;
    }
    this.releaseClientRetentionIfIdle();
    return true;
  }

  private async deliverPendingCompletion(
    state: ParentState,
    childState: ChildState,
  ): Promise<void> {
    const completion = childState.pendingCompletion;
    if (
      !completion ||
      this.childStates.get(childState.runId) !== childState ||
      this.parentStates.get(state.parentThreadId) !== state ||
      this.retiredParentStates.has(state)
    ) {
      return;
    }
    if (childState.deliveringCompletion || childState.completionDeliveryTimer) {
      return;
    }
    childState.deliveringCompletion = true;
    try {
      if (!this.persistPendingCompletion(state, childState)) {
        return;
      }
      // Foreground parents already receive native completion input. Persist the
      // result now, but only wake a detached parent after its last owner leaves.
      if (state.owners.size > 0 || !state.taskRuntimeScope) {
        return;
      }
      const delivery = await this.runtime.deliverAgentHarnessTaskCompletion({
        scope: state.taskRuntimeScope,
        childSessionKey: childState.runId,
        childSessionId: completion.childThreadId,
        announceId: `codex-native:${state.parentThreadId}:${readCodexNativeSubagentRunId(childState.runId)?.turnId ? childState.runId : completion.childThreadId}:${completion.status}`,
        announceType: "Subagent",
        taskLabel: "Subagent",
        status: completion.status,
        statusLabel: completion.statusLabel,
        result: completion.result,
        replyInstruction:
          "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup.",
      });
      if (
        this.childStates.get(childState.runId) !== childState ||
        this.parentStates.get(state.parentThreadId) !== state
      ) {
        return;
      }
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        childState.nativeCompletionDelivered = true;
        childState.completionTaskPhase = "delivery";
        this.persistPendingCompletion(state, childState);
        return;
      }
      const error = delivery.error ?? "completion delivery did not produce a parent response";
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: childState.runId,
        deliveryStatus: "pending",
        error,
      });
      this.scheduleCompletionDeliveryRetry(childState, error);
    } catch (error) {
      if (
        this.childStates.get(childState.runId) !== childState ||
        this.parentStates.get(state.parentThreadId) !== state
      ) {
        return;
      }
      const message = formatErrorMessage(error);
      this.scheduleCompletionDeliveryRetry(childState, message);
      if (!childState.completionTaskPhase) {
        state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
          runId: childState.runId,
          deliveryStatus: "pending",
          error: message,
        });
      }
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: message,
      });
    } finally {
      childState.deliveringCompletion = false;
    }
  }

  private recordNativeCompletionDelivery(
    state: ParentState,
    notification: CodexServerNotification,
  ): void {
    const trackers = new Set([state.deliveryReceipts]);
    // A fresh parent can consume a receipt before history reveals its alias.
    // Observe that current receipt in retained assignment owners too; never copy
    // an earlier parent's unmatched receipt into the new parent's tracker.
    for (const known of this.knownChildren.values()) {
      if (known.parent === state) {
        trackers.add(known.deliveryReceipts);
      }
    }
    for (const { candidate } of [
      ...this.taskReconciliations.values(),
      ...this.taskReconciliationTimers.values(),
    ]) {
      if (
        candidate.parentState.parentThreadId === state.parentThreadId &&
        candidate.requesterSessionKey === state.requesterSessionKey &&
        !this.retiredParentStates.has(candidate.parentState)
      ) {
        trackers.add(candidate.deliveryReceipts);
      }
    }
    for (const tracker of trackers) {
      this.applyNativeReceipts(state, tracker.observe(notification));
    }
  }

  private applyNativeReceipts(state: ParentState, runIds: readonly string[]): void {
    for (const runId of runIds) {
      const child = this.childStates.get(runId);
      if (child?.parentThreadId === state.parentThreadId) {
        child.nativeCompletionDelivered = true;
        if (child.pendingCompletion && !child.deliveringCompletion) {
          this.finishCompletionDelivery(state, child);
        }
      }
    }
  }

  private finishCompletionDelivery(state: ParentState, child: ChildState): void {
    child.completionTaskPhase ??= "delivery";
    if (child.completionDeliveryTimer) {
      clearTimeout(child.completionDeliveryTimer);
      child.completionDeliveryTimer = undefined;
    }
    void this.deliverPendingCompletion(state, child);
  }

  private deliverDetachedCompletions(state: ParentState): void {
    for (const child of this.childStates.values()) {
      if (child.parentThreadId === state.parentThreadId && child.pendingCompletion) {
        void this.deliverPendingCompletion(state, child);
      }
    }
  }

  private scheduleCompletionDeliveryRetry(childState: ChildState, error: string): void {
    if (
      !childState.pendingCompletion ||
      childState.completionDeliveryTimer ||
      this.childStates.get(childState.runId) !== childState
    ) {
      return;
    }
    if (
      !childState.completionTaskPhase &&
      childState.completionDeliveryAttempt >= this.completionDeliveryMaxRetries
    ) {
      const state = this.parentStates.get(childState.parentThreadId);
      state?.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: childState.runId,
        deliveryStatus: "failed",
        error,
      });
      this.unregisterChild(childState);
      return;
    }
    const delayMs = delayForAttempt(
      this.completionDeliveryRetryDelaysMs,
      childState.completionDeliveryAttempt++,
    );
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      if (this.childStates.get(childState.runId) !== childState) {
        return;
      }
      const state = this.parentStates.get(childState.parentThreadId);
      if (state) {
        void this.deliverPendingCompletion(state, childState);
      }
    }, delayMs);
    unrefTimer(childState.completionDeliveryTimer);
  }

  private resolveChildReceiptOwner(
    state: ParentState,
    childThreadId: string,
  ): CodexNativeSubagentDeliveryReceipts {
    const known = this.knownChildren.get(childThreadId);
    if (known?.parent === state) {
      return known.deliveryReceipts;
    }
    // Parent registration can end while a read or retry still owns the child's
    // receipts. Reuse that owner when stored lineage recreates the known child.
    for (const { candidate } of [
      ...this.taskReconciliations.values(),
      ...this.taskReconciliationTimers.values(),
    ]) {
      if (
        candidate.childThreadId === childThreadId &&
        candidate.parentState.parentThreadId === state.parentThreadId &&
        candidate.requesterSessionKey === state.requesterSessionKey &&
        !this.retiredParentStates.has(candidate.parentState)
      ) {
        return candidate.deliveryReceipts;
      }
    }
    return state.deliveryReceipts;
  }

  private pendingChildRecoveries(state: ParentState, threadId: string): TaskRecoveryCandidate[] {
    return [
      ...new Set(
        [...this.taskReconciliations.values(), ...this.taskReconciliationTimers.values()].map(
          ({ candidate }) => candidate,
        ),
      ),
    ].filter(
      (candidate) =>
        candidate.childThreadId === threadId &&
        candidate.requesterSessionKey === state.requesterSessionKey &&
        candidate.parentState.parentThreadId === state.parentThreadId &&
        !this.retiredParentStates.has(candidate.parentState),
    );
  }

  private resolveChildTurnBuffer(state: ParentState, threadId: string): NativeTurnObservation[] {
    return this.pendingChildRecoveries(state, threadId)[0]?.observedTurns ?? [];
  }

  private captureUnregisteredChildTurn(
    notification: CodexServerNotification,
    params: JsonObject | undefined,
  ): void {
    if (notification.method !== "turn/started" && notification.method !== "turn/completed") {
      return;
    }
    const threadId = readString(params, "threadId");
    const turn = isJsonObject(params?.turn) ? params.turn : undefined;
    const turnId = readString(turn, "id");
    if (!threadId || !turnId) {
      return;
    }
    const known = this.knownChildren.get(threadId);
    if (
      known &&
      (known.assignment.terminal || known.assignment.nativeTurnId || this.currentChild(threadId))
    ) {
      return;
    }
    const candidates = [
      ...new Set(
        [...this.taskReconciliations.values(), ...this.taskReconciliationTimers.values()].map(
          ({ candidate }) => candidate,
        ),
      ),
    ].filter(
      (candidate) =>
        candidate.childThreadId === threadId &&
        !this.retiredParentStates.has(candidate.parentState),
    );
    const buffers = new Set(candidates.map((candidate) => candidate.observedTurns));
    for (const turns of buffers) {
      const observed = turns.find((entry) => entry.turnId === turnId);
      if (notification.method === "turn/completed") {
        if (observed) {
          observed.state = readNativeTurnEnd(turn);
        } else {
          turns.push({ turnId, state: readNativeTurnEnd(turn) });
        }
      } else if (!observed) {
        const previous = turns.at(-1);
        if (previous?.state === "active") {
          previous.state = undefined;
        }
        turns.push({ turnId, state: "active", startObserved: true });
      }
    }
    for (const candidate of candidates) {
      const state = this.parentStates.get(candidate.parentState.parentThreadId);
      if (state) {
        this.associateUnregisteredChildInteractions(state, threadId);
      }
    }
    if (known && notification.method === "turn/started") {
      this.applyNativeReceipts(
        known.parent,
        known.deliveryReceipts.track(codexNativeSubagentRunId(threadId, turnId), known.agentPaths),
      );
    }
  }

  private associateUnregisteredChildInteractions(state: ParentState, threadId: string): void {
    const known = this.knownChildren.get(threadId);
    if (known && (known.assignment.terminal || known.assignment.nativeTurnId)) {
      return;
    }
    const candidate = this.pendingChildRecoveries(state, threadId)[0];
    if (!candidate) {
      return;
    }
    const currentTurnId =
      candidate.nativeTurnId ??
      (!candidate.terminal ? candidate.observedTurns[0]?.turnId : undefined);
    const interactions = [...this.pendingChildAdmissionEvidence.values()]
      .flat()
      .filter(
        (evidence) =>
          evidence.kind === "interaction" &&
          evidence.parentThreadId === state.parentThreadId &&
          evidence.childThreadId === threadId,
      );
    for (const turn of candidate.observedTurns) {
      if (turn.turnId === currentTurnId) {
        continue;
      }
      const interaction =
        interactions.find(
          (entry) => entry.kind === "interaction" && entry.nativeTurnId === turn.turnId,
        ) ?? interactions.find((entry) => entry.kind === "interaction" && !entry.nativeTurnId);
      if (interaction?.kind !== "interaction") {
        continue;
      }
      interaction.nativeTurnId = turn.turnId;
      if (interaction.owner && [...state.owners.values()].includes(interaction.owner)) {
        interaction.admittedOwner = interaction.owner;
      }
    }
  }

  private registerChildThread(
    state: ParentState,
    childInput: string | NativeSubagentAssignment,
    options: {
      admitAssignment?: true;
      agentPath?: string;
      directOwner?: ParentOwner;
      observedTurns?: readonly NativeTurnObservation[];
    } = {},
  ): ChildState | undefined {
    const parentThreadId = state.parentThreadId;
    const preparedAssignment = typeof childInput === "string" ? undefined : childInput;
    const childThreadId =
      typeof childInput === "string" ? childInput.trim() : childInput.childThreadId;
    if (!parentThreadId || !childThreadId || this.disposed) {
      return undefined;
    }
    const claimDirectChild = options.directOwner?.claimDirectChild;
    if (claimDirectChild && this.threadStatusRevisions.get(childThreadId)?.terminal) {
      // A late spawn event is observational only after this client has seen
      // the child's terminal state; it must not recreate direct authority.
      return undefined;
    }
    const known = this.knownChildren.get(childThreadId);
    const observedTurns =
      options.observedTurns ?? (!known ? this.resolveChildTurnBuffer(state, childThreadId) : []);
    if (known && known.parent !== state) {
      embeddedAgentLog.warn("Ignoring Codex native subagent child reparenting", {
        childThreadId,
        existingParentThreadId: known.parent.parentThreadId,
        attemptedParentThreadId: parentThreadId,
      });
      return undefined;
    }
    const assignment = preparedAssignment ?? {
      runId: known?.assignment.runId ?? codexNativeSubagentRunId(childThreadId),
      childThreadId,
      nativeTurnId: undefined,
    };
    const { runId } = assignment;
    let childState = this.childStates.get(runId);
    if (!childState && known && !preparedAssignment) {
      // Reading an old receiver does not start another assignment.
      return undefined;
    }
    if (!childState) {
      this.updateChildThreadOwnership("claim", childThreadId, this.claimChildThread);
      this.releaseClientRetention ??= this.retainClient?.();
      if (!this.parentThreadRetentions.has(parentThreadId)) {
        const releaseParentThread = this.retainParentThread?.(parentThreadId);
        if (releaseParentThread) {
          // Child completion can be announced on its parent's subscription
          // after the foreground parent turn has already released ownership.
          this.parentThreadRetentions.set(parentThreadId, releaseParentThread);
        }
      }
      childState = {
        runId,
        nativeTurnId: assignment.nativeTurnId,
        nativeTurnState: observedTurns.find((turn) => turn.turnId === assignment.nativeTurnId)
          ?.state,
        deliveryReceipts: this.resolveChildReceiptOwner(state, childThreadId),
        childThreadId,
        parentThreadId,
        agentId: state.agentId,
        assistantMessagesByTurn: new Map<string, ChildAssistantMessages>(),
        recoveryAttempt: 0,
        terminal: false,
        nativeCompletionDelivered: false,
        settledWithoutCompletion: false,
        completionDeliveryAttempt: 0,
        deliveringCompletion: false,
      };
      this.childStates.set(runId, childState);
      if (
        !known ||
        (!known.assignment.nativeTurnId && assignment.nativeTurnId && observedTurns.length > 0)
      ) {
        // A notification or history read can reveal lineage after registration.
        // Seed every prior assignment before discovering aliases can match receipts.
        const taskRecords = state.taskRuntime?.listTaskRecords() ?? [];
        this.restoreKnownChild(state, assignment, taskRecords, observedTurns);
        this.restoreTaskReceipts(state, taskRecords);
      }
      this.threadStatusRevisions.set(
        childThreadId,
        this.threadStatusRevisions.get(childThreadId) ?? {
          value: 0,
          readers: 0,
          parentThreadId,
        },
      );
    }
    if (known && options.admitAssignment) {
      known.assignment = {
        ...assignment,
        terminal:
          childState.terminal || (known.assignment.runId === runId && known.assignment.terminal),
      };
    }
    if (
      claimDirectChild &&
      !childState.terminal &&
      !childState.settledWithoutCompletion &&
      !childState.releaseDirectChild
    ) {
      childState.directOwner = options.directOwner;
      childState.releaseDirectChild = claimDirectChild(childThreadId);
    }
    this.registerAgentPath(state, childThreadId, childThreadId);
    state.mirror?.markAuthoritativeCompletionExpected(childThreadId);
    const agentPath = normalizeOptionalString(options.agentPath);
    if (agentPath) {
      this.registerAgentPath(state, childThreadId, agentPath);
    }
    for (const path of this.knownChildren.get(childThreadId)?.agentPaths ?? []) {
      this.registerAgentPath(state, childThreadId, path);
    }
    this.applyNativeReceipts(
      state,
      childState.deliveryReceipts.track(
        runId,
        this.knownChildren.get(childThreadId)?.agentPaths ?? [childThreadId],
      ),
    );
    const restored = this.knownChildren.get(childThreadId);
    if (observedTurns.length > 0 && restored?.parent === state) {
      if (!restored.assignment.terminal && !this.currentChild(childThreadId)) {
        this.registerChildThread(state, restored.assignment, { observedTurns });
      }
      const pendingAdmissions = [...this.pendingChildAdmissionEvidence];
      for (const [parentTurnId, pending] of pendingAdmissions) {
        const owners = new Set<ParentOwner>();
        for (const entry of pending) {
          if (
            entry.kind !== "interaction" ||
            entry.parentThreadId !== state.parentThreadId ||
            entry.childThreadId !== childThreadId
          ) {
            continue;
          }
          const owner = entry.admittedOwner ?? entry.owner;
          if (owner) {
            owners.add(owner);
          }
        }
        for (const owner of owners) {
          this.drainPendingChildAdmissionEvidence(state, owner, parentTurnId, true);
        }
      }
      for (const candidate of this.pendingChildRecoveries(state, childThreadId)) {
        candidate.observedTurns.length = 0;
      }
    }
    this.scheduleRecoveryPoll(childState);
    return childState;
  }

  private currentChild(threadId: string): ChildState | undefined {
    const runId = this.knownChildren.get(threadId)?.assignment.runId;
    return runId ? this.childStates.get(runId) : undefined;
  }

  private observeNativeChildTurnStart(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    const turnId = readString(turn, "id");
    const known = threadId ? this.knownChildren.get(threadId) : undefined;
    if (
      !threadId ||
      !turnId ||
      !known ||
      this.parentStates.get(known.parent.parentThreadId) !== known.parent
    ) {
      return true;
    }
    let previous = this.currentChild(threadId);
    if (
      !previous &&
      !known.assignment.terminal &&
      !known.assignment.nativeTurnId &&
      this.pendingChildRecoveries(known.parent, threadId).length > 0
    ) {
      return false;
    }
    if (!previous && !known.assignment.terminal) {
      previous = this.registerChildThread(known.parent, known.assignment);
    }
    const pending = known.pendingTurns.find((candidate) => candidate.turnId === turnId);
    if (
      known.observedTurns.has(turnId) &&
      (known.turnId !== turnId ||
        known.assignment.terminal ||
        pending ||
        previous?.nativeTurnState !== undefined)
    ) {
      return false;
    }
    const observedTurn = !known.observedTurns.has(turnId);
    const startsPendingTurn =
      !pending &&
      (known.pendingTurns.length > 0 ||
        known.assignment.unanchored ||
        !previous ||
        known.assignment.terminal ||
        previous.terminal ||
        previous.nativeTurnState === "completed" ||
        previous.nativeTurnState === "failed" ||
        (previous.nativeTurnId && previous.nativeTurnId !== turnId));
    if (observedTurn) {
      known.observedTurns.set(turnId, startsPendingTurn ? { awaitingInteraction: true } : {});
    }
    if (startsPendingTurn) {
      const previousPending = known.pendingTurns.at(-1);
      if (previousPending?.state === "active") {
        previousPending.state = undefined;
      }
      known.pendingTurns.push({ turnId, state: "active" });
      if (
        !previousPending &&
        previous &&
        !known.assignment.terminal &&
        !previous.terminal &&
        (!previous.nativeTurnState || previous.nativeTurnState === "active")
      ) {
        previous.nativeTurnState = undefined;
        previous.activityWait = undefined;
        this.releaseDirectChild(previous);
        previous.activityObserved = true;
        emitAgentEvent({
          runId: previous.runId,
          ...(previous.agentId ? { agentId: previous.agentId } : {}),
          stream: "execution",
          data: {
            state: "unknown",
            sourceId: this.observationSourceId,
            executionId: previous.nativeTurnId,
          },
        });
      }
      this.applyNativeReceipts(
        known.parent,
        known.deliveryReceipts.track(codexNativeSubagentRunId(threadId, turnId), known.agentPaths),
      );
    }
    known.turnId = turnId;
    if (previous && !previous.terminal && known.pendingTurns.length === 0) {
      previous.nativeTurnId = turnId;
      known.assignment.nativeTurnId = turnId;
      known.assignment.unanchored = undefined;
      previous.nativeTurnState = "active";
      known.parent.mirror?.recordNativeTurn(previous.runId, turnId);
    }
    if (observedTurn) {
      this.associatePendingChildInteraction(known, threadId, turnId);
    }
    this.admitFollowupChild(known, threadId);
    return true;
  }

  private associatePendingChildInteraction(
    known: KnownChild,
    threadId: string,
    nativeTurnId: string,
  ): void {
    for (const [parentTurnId, pending] of this.pendingChildAdmissionEvidence) {
      const interaction = pending.find(
        (evidence) =>
          evidence.kind === "interaction" &&
          evidence.parentThreadId === known.parent.parentThreadId &&
          evidence.childThreadId === threadId &&
          !evidence.nativeTurnId,
      );
      if (interaction?.kind !== "interaction") {
        continue;
      }
      interaction.nativeTurnId = nativeTurnId;
      const observed = known.observedTurns.get(nativeTurnId);
      if (observed) {
        observed.awaitingInteraction = undefined;
      }
      if (interaction.owner) {
        this.drainPendingChildAdmissionEvidence(known.parent, interaction.owner, parentTurnId);
      }
      return;
    }
  }

  private observeParentInteraction(
    state: ParentState,
    owner: ParentOwner | undefined,
    threadId: string,
    agentPath?: string,
    interaction: { parentTurnId?: string; itemId?: string } = {},
  ): void {
    const known = this.knownChildren.get(threadId);
    if (
      (known && known.parent !== state) ||
      (!known && this.pendingChildRecoveries(state, threadId).length === 0)
    ) {
      return;
    }
    if (known && agentPath) {
      this.registerAgentPath(state, threadId, agentPath);
    }
    const parentTurnId = interaction.parentTurnId ?? owner?.turnId;
    this.bufferPendingChildAdmissionEvidence(parentTurnId, {
      kind: "interaction",
      parentThreadId: state.parentThreadId,
      childThreadId: threadId,
      ...(agentPath ? { agentPath } : {}),
      ...(interaction.itemId ? { itemId: interaction.itemId } : {}),
      ...(owner ? { owner } : {}),
    });
    if (!known || (!known.assignment.terminal && !known.assignment.nativeTurnId)) {
      this.associateUnregisteredChildInteractions(state, threadId);
    }
    if (owner && parentTurnId) {
      this.drainPendingChildAdmissionEvidence(state, owner, parentTurnId, true);
    }
  }

  private admitFollowupChild(
    known: KnownChild,
    threadId: string,
    owner?: ParentOwner,
  ): ChildState | undefined {
    if (
      this.parentStates.get(known.parent.parentThreadId) !== known.parent ||
      this.retiredParentStates.has(known.parent)
    ) {
      return undefined;
    }
    let child = this.currentChild(threadId);
    if (!child && !known.assignment.terminal) {
      return undefined;
    }
    let claimOwner = owner;
    let transitioned = false;
    while (known.pendingTurns.length > 0) {
      const pending = known.pendingTurns[0]!;
      const currentTurnId = child?.nativeTurnId;
      const recoveredIndex = currentTurnId
        ? known.pendingTurns.findIndex((candidate) => candidate.turnId === currentTurnId)
        : -1;
      if (
        child &&
        !child.terminal &&
        !known.assignment.terminal &&
        (recoveredIndex >= 0 || child.nativeTurnState === "interrupted")
      ) {
        // History may traverse several interrupted continuations at once. Remove
        // every covered provisional boundary before any receipt matching resumes.
        let continuationCount = Math.max(1, recoveredIndex + 1);
        if (recoveredIndex < 0) {
          while (
            continuationCount < known.pendingTurns.length &&
            known.pendingTurns[continuationCount - 1]?.state === "interrupted"
          ) {
            continuationCount += 1;
          }
        }
        const continuations = known.pendingTurns.splice(0, continuationCount);
        const resumed = continuations.at(-1)!;
        if (recoveredIndex < 0) {
          child.nativeTurnId = resumed.turnId;
          child.nativeTurnState = resumed.state;
          child.activityWait = undefined;
          known.parent.mirror?.recordNativeTurn(child.runId, resumed.turnId);
        }
        claimOwner = resumed.admittedOwner;
        transitioned = true;
        this.applyNativeReceipts(
          known.parent,
          known.deliveryReceipts.resumeAssignment(
            child.runId,
            continuations.map((turn) => codexNativeSubagentRunId(threadId, turn.turnId)),
          ),
        );
        continue;
      }
      if (
        child &&
        !child.terminal &&
        !known.assignment.terminal &&
        child.nativeTurnState !== "completed" &&
        child.nativeTurnState !== "failed"
      ) {
        child.nativeTurnState = undefined;
        return undefined;
      }
      if (!pending.admittedOwner) {
        return undefined;
      }
      const runId = codexNativeSubagentRunId(threadId, pending.turnId);
      known.parent.mirror?.startFollowupTurn(threadId, pending.turnId);
      child = this.registerChildThread(
        known.parent,
        { runId, childThreadId: threadId, nativeTurnId: pending.turnId },
        { admitAssignment: true },
      );
      if (!child) {
        return undefined;
      }
      child.nativeTurnId = pending.turnId;
      child.nativeTurnState = pending.state;
      claimOwner = pending.admittedOwner;
      transitioned = true;
      known.pendingTurns.shift();
    }
    if (!child || child.terminal || known.assignment.terminal || !child.nativeTurnId) {
      return undefined;
    }
    known.assignment.nativeTurnId = child.nativeTurnId;
    known.turnId = child.nativeTurnId;
    if (child.nativeTurnState !== "active") {
      return child;
    }
    const currentInteraction = [...this.pendingChildAdmissionEvidence.values()]
      .flat()
      .findLast(
        (evidence) =>
          evidence.kind === "interaction" &&
          evidence.parentThreadId === known.parent.parentThreadId &&
          evidence.childThreadId === threadId &&
          !evidence.nativeTurnId &&
          evidence.owner &&
          [...known.parent.owners.values()].includes(evidence.owner),
      );
    if (currentInteraction?.kind === "interaction" && currentInteraction.owner) {
      claimOwner = currentInteraction.owner;
    }
    if (claimOwner && [...known.parent.owners.values()].includes(claimOwner)) {
      if (child.directOwner !== claimOwner) {
        this.releaseDirectChild(child);
        child.directOwner = claimOwner;
        child.releaseDirectChild = claimOwner.claimDirectChild?.(child.childThreadId);
      }
      if (!transitioned) {
        claimOwner.onDirectChildAccepted?.();
      }
    }
    return child;
  }

  private resolveParentOwner(
    state: ParentState,
    turnIdInput: string | undefined,
  ): ParentOwner | undefined {
    const turnId = turnIdInput?.trim();
    if (!turnId) {
      return undefined;
    }
    const owners = [...state.owners.values()].filter((owner) => owner.turnId === turnId);
    return owners.length === 1 ? owners[0] : undefined;
  }

  private registerDirectSpawnChild(
    state: ParentState,
    turnIdInput: string | undefined,
    evidence: DirectSpawnEvidence,
    owner: ParentOwner | undefined,
  ): ChildState | undefined {
    const childState = this.registerChildThread(state, evidence.childThreadId, {
      ...(evidence.agentPath === undefined ? {} : { agentPath: evidence.agentPath }),
      ...(owner?.claimDirectChild ? { directOwner: owner } : {}),
    });
    if (!owner) {
      this.bufferPendingChildAdmissionEvidence(turnIdInput, { ...evidence, kind: "spawn" });
    } else if (childState) {
      owner.onDirectChildAccepted?.();
    }
    return childState;
  }

  private bufferPendingChildAdmissionEvidence(
    turnIdInput: string | undefined,
    evidence: NativeChildAdmissionEvidence,
  ): void {
    const turnId = turnIdInput?.trim();
    const requiresUnboundOwner = evidence.kind !== "interaction" || !evidence.owner;
    if (!turnId || (requiresUnboundOwner && !this.hasUnboundParentOwner(evidence.parentThreadId))) {
      return;
    }
    const pending = this.pendingChildAdmissionEvidence.get(turnId) ?? [];
    if (evidence.kind === "interaction") {
      // Interrupted continuations leave the receipt queue before their
      // interaction can arrive. Keep pairing against the observed starts.
      const nativeTurn = [
        ...(this.knownChildren.get(evidence.childThreadId)?.observedTurns ?? []),
      ].find(
        ([nativeTurnId, observed]) =>
          observed.awaitingInteraction &&
          ![...this.pendingChildAdmissionEvidence.values()]
            .flat()
            .some(
              (candidate) =>
                candidate.kind === "interaction" &&
                candidate.parentThreadId === evidence.parentThreadId &&
                candidate.childThreadId === evidence.childThreadId &&
                candidate.nativeTurnId === nativeTurnId,
            ),
      );
      if (nativeTurn) {
        evidence.nativeTurnId = nativeTurn[0];
      }
    }
    if (
      pending.some(
        (candidate) =>
          candidate.parentThreadId === evidence.parentThreadId &&
          candidate.kind === evidence.kind &&
          candidate.childThreadId === evidence.childThreadId &&
          candidate.agentPath === evidence.agentPath &&
          (candidate.kind === "spawn" ||
            evidence.kind === "spawn" ||
            (candidate.nativeTurnId !== undefined &&
              candidate.nativeTurnId === evidence.nativeTurnId) ||
            (evidence.itemId !== undefined && candidate.itemId === evidence.itemId)),
      ) ||
      (requiresUnboundOwner &&
        [...this.pendingChildAdmissionEvidence.values()].reduce(
          (count, entries) => count + entries.length,
          0,
        ) >= MAX_PENDING_CHILD_ADMISSION_EVIDENCE)
    ) {
      return;
    }
    pending.push(evidence);
    this.pendingChildAdmissionEvidence.set(turnId, pending);
  }

  private drainPendingChildAdmissionEvidence(
    state: ParentState,
    owner: ParentOwner,
    turnId: string,
    observeActivity = false,
  ): void {
    const pending = this.pendingChildAdmissionEvidence.get(turnId);
    const ownerIsCurrent = [...state.owners.values()].includes(owner);
    if (
      !pending ||
      this.parentStates.get(state.parentThreadId) !== state ||
      this.retiredParentStates.has(state) ||
      (!ownerIsCurrent &&
        !pending.some((entry) => entry.kind === "interaction" && entry.admittedOwner === owner))
    ) {
      return;
    }
    const remaining: NativeChildAdmissionEvidence[] = [];
    const affectedChildren = new Set<string>();
    const unknownChildren = new Set<string>();
    for (const evidence of pending) {
      if (evidence.parentThreadId !== state.parentThreadId) {
        remaining.push(evidence);
        continue;
      }
      if (evidence.kind === "interaction") {
        if (!ownerIsCurrent && evidence.admittedOwner !== owner) {
          remaining.push(evidence);
          continue;
        }
        if (ownerIsCurrent) {
          evidence.owner = owner;
        }
        const known = this.knownChildren.get(evidence.childThreadId);
        if (known && known.parent !== state) {
          continue;
        }
        if (
          !known ||
          (!known.assignment.terminal &&
            !known.assignment.nativeTurnId &&
            !this.currentChild(evidence.childThreadId) &&
            this.pendingChildRecoveries(state, evidence.childThreadId).length > 0)
        ) {
          remaining.push(evidence);
          unknownChildren.add(evidence.childThreadId);
          continue;
        }
        if (evidence.agentPath && !known.agentPaths.has(evidence.agentPath)) {
          this.registerAgentPath(state, evidence.childThreadId, evidence.agentPath);
        }
        if (evidence.nativeTurnId) {
          const observed = known.observedTurns.get(evidence.nativeTurnId);
          if (observed) {
            observed.awaitingInteraction = undefined;
          }
          const nativeTurn = known.pendingTurns.find(
            (turn) => turn.turnId === evidence.nativeTurnId,
          );
          if (nativeTurn) {
            if (!nativeTurn.admittedOwner) {
              nativeTurn.admittedOwner = ownerIsCurrent ? owner : evidence.admittedOwner;
              if (ownerIsCurrent) {
                owner.onDirectChildAccepted?.();
              }
            }
          } else if (
            this.currentChild(evidence.childThreadId)?.nativeTurnId !== evidence.nativeTurnId
          ) {
            continue;
          }
        } else if (ownerIsCurrent) {
          remaining.push(evidence);
        } else {
          continue;
        }
        affectedChildren.add(evidence.childThreadId);
        continue;
      }
      if (!ownerIsCurrent || !owner.claimDirectChild) {
        continue;
      }
      const childState = this.registerChildThread(state, evidence.childThreadId, {
        ...(evidence.agentPath === undefined ? {} : { agentPath: evidence.agentPath }),
        directOwner: owner,
      });
      if (childState) {
        owner.onDirectChildAccepted?.();
      }
    }
    if (remaining.length) {
      this.pendingChildAdmissionEvidence.set(turnId, remaining);
    } else {
      this.pendingChildAdmissionEvidence.delete(turnId);
    }
    for (const threadId of unknownChildren) {
      this.associateUnregisteredChildInteractions(state, threadId);
    }
    for (const threadId of affectedChildren) {
      const known = this.knownChildren.get(threadId);
      if (known?.parent !== state) {
        continue;
      }
      const previous = this.currentChild(threadId);
      const child = this.admitFollowupChild(known, threadId, ownerIsCurrent ? owner : undefined);
      if (observeActivity && child && child !== previous && child.nativeTurnState === "active") {
        this.emitChildTaskActivity(
          { method: "turn/started", params: { threadId, turn: { id: child.nativeTurnId! } } },
          child,
        );
      }
    }
  }

  private hasUnboundParentOwner(parentThreadId: string): boolean {
    const owners = this.parentStates.get(parentThreadId)?.owners.values() ?? [];
    return [...owners].some((owner) => owner.turnId === undefined);
  }

  private clearUnconsumablePendingChildAdmissionEvidence(): void {
    this.filterPendingChildAdmissionEvidence((evidence) => {
      const known = this.knownChildren.get(evidence.childThreadId);
      if (known && known.parent.parentThreadId !== evidence.parentThreadId) {
        return false;
      }
      if (evidence.kind === "interaction" && evidence.owner) {
        const state = this.parentStates.get(evidence.parentThreadId);
        if (state && [...state.owners.values()].includes(evidence.owner)) {
          return true;
        }
        return Boolean(
          evidence.admittedOwner &&
          state &&
          this.pendingChildRecoveries(state, evidence.childThreadId).length > 0,
        );
      }
      return this.hasUnboundParentOwner(evidence.parentThreadId);
    });
  }

  private clearPendingChildAdmissionEvidenceForParent(parentThreadId: string): void {
    this.filterPendingChildAdmissionEvidence(
      (evidence) => evidence.parentThreadId !== parentThreadId,
    );
  }

  private removePendingSpawnAdmissionEvidenceForChild(childThreadId: string): void {
    this.filterPendingChildAdmissionEvidence(
      (evidence) => evidence.childThreadId !== childThreadId || evidence.kind === "interaction",
    );
  }

  private filterPendingChildAdmissionEvidence(
    keep: (evidence: NativeChildAdmissionEvidence) => boolean,
  ): void {
    for (const [turnId, pending] of this.pendingChildAdmissionEvidence) {
      const remaining = pending.filter(keep);
      if (remaining.length) {
        this.pendingChildAdmissionEvidence.set(turnId, remaining);
      } else {
        this.pendingChildAdmissionEvidence.delete(turnId);
      }
    }
  }

  private registerAgentPath(state: ParentState, childThreadId: string, agentPath: string): void {
    const known = this.knownChildren.get(childThreadId);
    if (known?.parent !== state) {
      return;
    }
    const key = buildParentAgentPathKey(state.parentThreadId, agentPath);
    const existingChild = this.childThreadIdsByAgentPath.get(key);
    if (existingChild && existingChild !== childThreadId) {
      embeddedAgentLog.warn("Ignoring conflicting Codex native subagent agent path", {
        parentThreadId: state.parentThreadId,
        agentPath,
        existingChildThreadId: existingChild,
        attemptedChildThreadId: childThreadId,
      });
      return;
    }
    this.childThreadIdsByAgentPath.set(key, childThreadId);
    known.agentPaths.add(agentPath);
    this.applyNativeReceipts(state, known.deliveryReceipts.addAlias(childThreadId, agentPath));
  }

  private unregisterChild(
    childState: ChildState,
    options: { retainSubscription?: boolean } = {},
  ): void {
    this.releaseDirectChild(childState);
    if (
      childState.terminal &&
      !childState.subscriptionClosed &&
      options.retainSubscription !== false &&
      !this.disposed &&
      this.knownChildren.get(childState.childThreadId)?.assignment.runId === childState.runId
    ) {
      // Completed Codex children intentionally remain reusable. Transfer their
      // auto-subscription into the shared bounded warm-thread owner, not oblivion.
      this.updateChildThreadOwnership("retain", childState.childThreadId, this.retainChildThread);
    }
    this.clearRecoveryTimers(childState);
    if (childState.completionDeliveryTimer) {
      clearTimeout(childState.completionDeliveryTimer);
    }
    const deliveryOwnerKey = childState.deliveryOwnerKey;
    if (deliveryOwnerKey && completionDeliveryOwners.get(deliveryOwnerKey) === childState) {
      completionDeliveryOwners.delete(deliveryOwnerKey);
    }
    childState.deliveryOwnerKey = undefined;
    if (this.childStates.get(childState.runId) === childState) {
      this.childStates.delete(childState.runId);
    }
    if (
      ![...this.childStates.values()].some(
        (remainingChild) => remainingChild.parentThreadId === childState.parentThreadId,
      )
    ) {
      const releaseParentThread = this.parentThreadRetentions.get(childState.parentThreadId);
      this.parentThreadRetentions.delete(childState.parentThreadId);
      releaseParentThread?.();
    }
    this.collectThreadStatusRevision(childState.childThreadId);
    this.releaseClientRetentionIfIdle();
    const state = this.parentStates.get(childState.parentThreadId);
    if (state) {
      this.pruneParentIfUnused(state);
    }
  }

  private releaseDirectChild(childState: ChildState): void {
    const release = childState.releaseDirectChild;
    childState.releaseDirectChild = undefined;
    childState.directOwner = undefined;
    release?.();
  }

  private rejectPendingDirectChild(
    state: ParentState,
    childThreadId: string,
    reason: string,
  ): void {
    if (
      [...this.pendingChildAdmissionEvidence.values()]
        .flat()
        .some(
          (evidence) =>
            evidence.kind === "interaction" &&
            evidence.parentThreadId === state.parentThreadId &&
            evidence.childThreadId === childThreadId,
        )
    ) {
      // The ended turn cannot reject hooks waiting for an accepted follow-up.
      return;
    }
    for (const owner of state.owners.values()) {
      owner.rejectPendingDirectChild?.(childThreadId, reason);
    }
  }

  private updateChildThreadOwnership(
    operation: "claim" | "retain" | "release",
    childThreadId: string,
    update: ((threadId: string) => Promise<unknown>) | undefined,
  ): void {
    if (!update) {
      return;
    }
    void update(childThreadId).catch((error: unknown) => {
      embeddedAgentLog.warn("Failed to update Codex native subagent thread ownership", {
        operation,
        childThreadId,
        error: formatErrorMessage(error),
      });
    });
  }

  private releaseClientRetentionIfIdle(): void {
    if (
      [...this.childStates.values()].some(
        (childState) => !childState.terminal && !childState.settledWithoutCompletion,
      )
    ) {
      return;
    }
    this.releaseRetainedClient();
  }

  private releaseRetainedClient(): void {
    const release = this.releaseClientRetention;
    this.releaseClientRetention = undefined;
    release?.();
  }

  private claimCompletionDelivery(state: ParentState, childState: ChildState): boolean {
    const requesterSessionKey = state.requesterSessionKey?.trim();
    if (!requesterSessionKey) {
      return true;
    }
    const key = `${requesterSessionKey}\0${childState.runId}`;
    const owner = completionDeliveryOwners.get(key);
    if (owner) {
      return owner === childState;
    }
    const runId = childState.runId;
    const task = state.taskRuntime?.listTaskRecords().find((record) => record.runId === runId);
    if (task?.deliveryStatus === "delivered") {
      return false;
    }
    childState.completionTaskId = task?.taskId;
    // Delivery no longer needs the app-server client. Keep one process owner
    // across client replacement so fallback steering cannot inject twice.
    completionDeliveryOwners.set(key, childState);
    childState.deliveryOwnerKey = key;
    return true;
  }

  private pruneParentIfUnused(state: ParentState): void {
    if (state.owners.size > 0) {
      return;
    }
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId === state.parentThreadId) {
        return;
      }
    }
    if (
      !this.retiredParentStates.has(state) &&
      [...this.taskReconciliations.values(), ...this.taskReconciliationTimers.values()].some(
        ({ candidate }) => candidate.parentState === state,
      )
    ) {
      return;
    }
    if (this.parentStates.get(state.parentThreadId) === state) {
      this.clearTerminalRevisionsForParent(state.parentThreadId);
      this.parentStates.delete(state.parentThreadId);
      for (const [threadId, known] of this.knownChildren) {
        if (known.parent === state) {
          for (const path of known.agentPaths) {
            this.childThreadIdsByAgentPath.delete(
              buildParentAgentPathKey(state.parentThreadId, path),
            );
          }
          this.knownChildren.delete(threadId);
        }
      }
    }
  }

  private clearTerminalRevisionsForParent(parentThreadId: string): void {
    for (const [threadId, revision] of this.threadStatusRevisions) {
      if (revision.parentThreadId === parentThreadId) {
        this.collectThreadStatusRevision(threadId, revision);
      }
    }
  }

  private collectThreadStatusRevision(
    threadId: string,
    revision = this.threadStatusRevisions.get(threadId),
  ) {
    if (!revision || revision.readers > 0 || Boolean(this.currentChild(threadId))) {
      return;
    }
    const parent = revision.parentThreadId
      ? this.parentStates.get(revision.parentThreadId)
      : undefined;
    if (parent?.owners.size) {
      return;
    }
    if (this.threadStatusRevisions.get(threadId) === revision) {
      this.threadStatusRevisions.delete(threadId);
    }
  }

  private scheduleRecoveryPoll(childState: ChildState): void {
    if (
      childState.terminal ||
      childState.settledWithoutCompletion ||
      childState.recoveryTimer ||
      this.disposed ||
      this.recoveryPollDelaysMs.length === 0
    ) {
      return;
    }
    const delayMs = delayForAttempt(this.recoveryPollDelaysMs, childState.recoveryAttempt++);
    childState.recoveryTimer = setTimeout(() => {
      childState.recoveryTimer = undefined;
      void this.reconcileRegisteredChild(childState)
        .catch((error: unknown) => {
          this.logRecoveryFailure(childState.childThreadId, error);
          return false;
        })
        .then(async (reconciled) => {
          if (reconciled || this.childStates.get(childState.runId) !== childState) {
            return;
          }
          const fallback = childState.fallbackCompletion;
          const state = this.parentStates.get(childState.parentThreadId);
          // Give thread/read two persistence windows before delivering the
          // typed no-final result; otherwise a just-written final can be lost.
          if (fallback && state && childState.recoveryAttempt >= 2) {
            await this.processCompletion(
              state,
              childState,
              fallback,
              fallback.completedAt ?? this.now(),
            );
            return;
          }
          this.scheduleRecoveryPoll(childState);
        });
    }, delayMs);
    unrefTimer(childState.recoveryTimer);
  }

  private setRecoveryFallback(
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ): void {
    if (childState.terminal) {
      return;
    }
    const current = childState.fallbackCompletion;
    if (
      current?.status === completion.status &&
      current.statusLabel === completion.statusLabel &&
      current.result === completion.result
    ) {
      return;
    }
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
    childState.recoveryAttempt = 0;
    childState.fallbackCompletion = { ...completion, completedAt: eventAt };
    this.scheduleRecoveryPoll(childState);
  }

  private clearSystemErrorFallback(childState: ChildState): void {
    if (childState.fallbackCompletion?.statusLabel !== "system_error") {
      return;
    }
    childState.fallbackCompletion = undefined;
  }

  private retainThreadStatusRevision(threadId: string): {
    isCurrent: () => boolean;
    release: () => void;
  } {
    const revision = this.threadStatusRevisions.get(threadId) ?? { value: 0, readers: 0 };
    this.threadStatusRevisions.set(threadId, revision);
    revision.readers += 1;
    const capturedValue = revision.value;
    let retained = true;
    return {
      isCurrent: () =>
        this.threadStatusRevisions.get(threadId) === revision && revision.value === capturedValue,
      release: () => {
        if (!retained) {
          return;
        }
        retained = false;
        revision.readers -= 1;
        this.collectThreadStatusRevision(threadId, revision);
      },
    };
  }

  private clearRecoveryTimers(childState: ChildState): void {
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
  }

  private async reconcileTaskRowsForParent(state: ParentState): Promise<void> {
    if (
      this.disposed ||
      this.parentStates.get(state.parentThreadId) !== state ||
      !state.taskRuntime ||
      !state.requesterSessionKey ||
      !state.taskRuntimeScope
    ) {
      return;
    }
    // The scoped runtime already filters runtime, task kind, and run-id prefix.
    // Keep the session check because multiple parents can share one client.
    const candidates = new Map<string, TaskRecoveryCandidate>();
    const turnBuffers = new Map<string, NativeTurnObservation[]>();
    const taskRecords = state.taskRuntime
      .listTaskRecords()
      .toSorted((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
    for (const task of taskRecords) {
      if (task.requesterSessionKey !== state.requesterSessionKey) {
        continue;
      }
      const assignment = readNativeTaskAssignment(task);
      const history = readCodexNativeSubagentHistoryOwner(task.detail);
      if (
        assignment &&
        history?.parentThreadId === state.parentThreadId &&
        !this.knownChildren.has(assignment.childThreadId)
      ) {
        this.restoreKnownChild(state, assignment, taskRecords);
      }
      if (!this.shouldReconcileCodexNativeTask(task)) {
        continue;
      }
      if (!assignment) {
        continue;
      }
      const childThreadId = assignment.childThreadId;
      const observedTurns =
        turnBuffers.get(childThreadId) ?? this.resolveChildTurnBuffer(state, childThreadId);
      turnBuffers.set(childThreadId, observedTurns);
      candidates.set(assignment.runId, {
        runId: assignment.runId,
        nativeTurnId: assignment.nativeTurnId,
        terminal:
          task.status === "succeeded" || task.status === "failed" || task.status === "cancelled",
        observedTurns,
        parentState: state,
        deliveryReceipts: this.resolveChildReceiptOwner(state, childThreadId),
        requesterSessionKey: state.requesterSessionKey,
        childThreadId,
        recoveryAttempt: 0,
        taskRuntimeScope: state.taskRuntimeScope,
        agentId: state.agentId,
        taskRuntime: state.taskRuntime,
      });
    }
    this.restoreTaskReceipts(state, taskRecords);
    let previous: Promise<void> | undefined;
    for (const candidate of candidates.values()) {
      previous = this.reconcileTaskCandidate(candidate, previous).catch((error: unknown) => {
        this.logRecoveryFailure(candidate.childThreadId, error);
      });
    }
    await previous;
  }

  private restoreKnownChild(
    state: ParentState,
    assignment: NativeSubagentAssignment,
    taskRecords: readonly AgentHarnessTaskRecord[],
    observedTurns: readonly NativeTurnObservation[] = [],
  ): void {
    let current: NativeSubagentAssignment & { initialTurnId?: string } = assignment;
    let latestAt = -Infinity;
    let terminal = false;
    const storedTurnIds = new Set<string>();
    for (const task of taskRecords) {
      const candidate = readNativeTaskAssignment(task);
      if (
        task.requesterSessionKey !== state.requesterSessionKey ||
        candidate?.childThreadId !== assignment.childThreadId
      ) {
        continue;
      }
      const history = readCodexNativeSubagentHistoryOwner(task.detail);
      if (history && history.parentThreadId !== state.parentThreadId) {
        continue;
      }
      const taskTerminal =
        task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
      if (taskTerminal) {
        state.mirror?.markAuthoritativeCompletion(assignment.childThreadId, candidate.runId);
      }
      for (const turnId of [candidate.nativeTurnId, candidate.initialTurnId]) {
        if (turnId) {
          storedTurnIds.add(turnId);
        }
      }
      const startedAt = task.startedAt ?? task.createdAt;
      if (startedAt > latestAt) {
        current = {
          ...candidate,
          nativeTurnId:
            candidate.nativeTurnId ??
            (candidate.runId === assignment.runId ? assignment.nativeTurnId : undefined),
        };
        terminal = taskTerminal;
        latestAt = startedAt;
      }
    }
    if (latestAt !== -Infinity) {
      // Recovery may visit older rows later; lifecycle events belong to the selected current run.
      state.mirror?.restoreCurrentTaskRun(assignment.childThreadId, current.runId);
    }
    const currentIndex = observedTurns.findIndex((turn) => turn.turnId === current.nativeTurnId);
    const pendingTurns = observedTurns
      .filter(
        (turn, index) =>
          index > currentIndex &&
          turn.turnId !== current.nativeTurnId &&
          !storedTurnIds.has(turn.turnId),
      )
      .map((turn, index, turns) => ({
        turnId: turn.turnId,
        state: turn.state === "active" && index < turns.length - 1 ? undefined : turn.state,
      }));
    this.knownChildren.set(assignment.childThreadId, {
      parent: state,
      deliveryReceipts: this.resolveChildReceiptOwner(state, assignment.childThreadId),
      assignment: {
        ...current,
        terminal,
        unanchored: !terminal && !current.nativeTurnId && latestAt !== -Infinity ? true : undefined,
      },
      turnId: pendingTurns.at(-1)?.turnId ?? current.nativeTurnId,
      observedTurns: new Map(
        [
          ...new Set(
            [
              ...storedTurnIds,
              current.nativeTurnId,
              current.initialTurnId,
              ...observedTurns.map((turn) => turn.turnId),
            ].filter((id): id is string => Boolean(id)),
          ),
        ].map((turnId) => [
          turnId,
          pendingTurns.some((turn) => turn.turnId === turnId) ? { awaitingInteraction: true } : {},
        ]),
      ),
      pendingTurns,
      agentPaths:
        this.knownChildren.get(assignment.childThreadId)?.agentPaths ??
        new Set([assignment.childThreadId]),
    });
  }

  private restoreTaskReceipts(
    state: ParentState,
    taskRecords: readonly AgentHarnessTaskRecord[],
  ): void {
    const snapshots = new Map<
      CodexNativeSubagentDeliveryReceipts,
      Array<{ runId: string; paths: Iterable<string>; result?: string }>
    >();
    // The task runtime lists newest insertions first, including timestamp ties.
    for (const task of taskRecords
      .toReversed()
      .toSorted((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))) {
      if (task.requesterSessionKey !== state.requesterSessionKey) {
        continue;
      }
      const assignment = readNativeTaskAssignment(task);
      if (!assignment) {
        continue;
      }
      const known = this.knownChildren.get(assignment.childThreadId);
      const history = readCodexNativeSubagentHistoryOwner(task.detail);
      if (
        (known && known.parent !== state) ||
        (history ? history.parentThreadId !== state.parentThreadId : known?.parent !== state)
      ) {
        continue;
      }
      const receipts = known?.deliveryReceipts ?? state.deliveryReceipts;
      const snapshot = snapshots.get(receipts) ?? [];
      snapshot.push({
        runId: assignment.runId,
        paths: known?.agentPaths ?? [assignment.childThreadId],
        ...(task.terminalSummary ? { result: task.terminalSummary } : {}),
      });
      snapshots.set(receipts, snapshot);
    }
    for (const [threadId, known] of this.knownChildren) {
      if (known.parent !== state || known.pendingTurns.length === 0) {
        continue;
      }
      const snapshot = snapshots.get(known.deliveryReceipts) ?? [];
      for (const turn of known.pendingTurns) {
        snapshot.push({
          runId: codexNativeSubagentRunId(threadId, turn.turnId),
          paths: known.agentPaths,
        });
      }
      snapshots.set(known.deliveryReceipts, snapshot);
    }
    for (const [receipts, snapshot] of snapshots) {
      this.applyNativeReceipts(state, receipts.restore(snapshot));
    }
  }

  private async reconcileTaskCandidate(
    candidate: TaskRecoveryCandidate,
    after?: Promise<void>,
  ): Promise<void> {
    const key = `${candidate.requesterSessionKey}\0${candidate.runId}`;
    const scheduled = this.taskReconciliationTimers.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.taskReconciliationTimers.delete(key);
    }
    const existing = this.taskReconciliations.get(key);
    if (existing) {
      await existing.promise;
      return;
    }
    // Hold single-flight through delivery. Releasing after the read lets a slower
    // reconcile recreate a just-pruned child and deliver the same result twice.
    const reconciliation = after
      ? after.then(() => this.reconcileTaskCandidateOnce(candidate))
      : this.reconcileTaskCandidateOnce(candidate);
    this.taskReconciliations.set(key, { candidate, promise: reconciliation });
    try {
      await reconciliation;
    } finally {
      if (this.taskReconciliations.get(key)?.promise === reconciliation) {
        this.taskReconciliations.delete(key);
      }
      this.clearUnconsumablePendingChildAdmissionEvidence();
      this.pruneParentIfUnused(candidate.parentState);
    }
  }

  private scheduleTaskCandidateReconciliation(candidate: TaskRecoveryCandidate): void {
    const key = `${candidate.requesterSessionKey}\0${candidate.runId}`;
    if (
      this.disposed ||
      this.retiredParentStates.has(candidate.parentState) ||
      this.recoveryPollDelaysMs.length === 0 ||
      this.taskReconciliationTimers.has(key)
    ) {
      return;
    }
    const delayMs = delayForAttempt(this.recoveryPollDelaysMs, candidate.recoveryAttempt++);
    const timer = setTimeout(() => {
      this.taskReconciliationTimers.delete(key);
      void this.reconcileTaskCandidate(candidate).catch((error: unknown) => {
        this.logRecoveryFailure(candidate.childThreadId, error);
        this.scheduleTaskCandidateReconciliation(candidate);
      });
    }, delayMs);
    this.taskReconciliationTimers.set(key, { candidate, timer });
    unrefTimer(timer);
  }

  private async reconcileTaskCandidateOnce(candidate: TaskRecoveryCandidate): Promise<void> {
    if (this.disposed || this.retiredParentStates.has(candidate.parentState)) {
      return;
    }
    const runId = candidate.runId;
    const task = candidate.taskRuntime.listTaskRecords().find((record) => record.runId === runId);
    if (
      !task ||
      task.requesterSessionKey !== candidate.requesterSessionKey ||
      !this.shouldReconcileCodexNativeTask(task)
    ) {
      return;
    }
    const childBeforeRead = this.childStates.get(candidate.runId);
    let assignment = childBeforeRead ?? readNativeTaskAssignment(task);
    if (!assignment) {
      return;
    }
    candidate.terminal =
      task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
    candidate.nativeTurnId = assignment.nativeTurnId;
    const statusRead = this.retainThreadStatusRevision(assignment.childThreadId);
    try {
      let recovery: ThreadRecovery;
      try {
        const unfinished = task.status === "queued" || task.status === "running";
        const recordedStatus =
          task.status === "succeeded" || task.status === "failed" || task.status === "cancelled"
            ? task.status
            : undefined;
        recovery = await this.readThreadRecovery(assignment, {
          resumeInterrupted: unfinished,
          observedTurns: candidate.observedTurns,
          ...(recordedStatus && task.terminalSummary
            ? {
                recordedCompletion: {
                  childThreadId: candidate.childThreadId,
                  status: recordedStatus,
                  statusLabel: "recorded_task_result",
                  result: task.terminalSummary,
                  completedAt: task.endedAt,
                },
              }
            : {}),
        });
      } catch (error) {
        this.logRecoveryFailure(candidate.childThreadId, error);
        this.scheduleTaskCandidateReconciliation(candidate);
        return;
      }
      if (this.retiredParentStates.has(candidate.parentState)) {
        return;
      }
      if (!statusRead.isCurrent() || this.childStates.get(candidate.runId) !== childBeforeRead) {
        this.scheduleTaskCandidateReconciliation(candidate);
        return;
      }
      const parentThreadId = recovery.parentThreadId;
      if (!parentThreadId) {
        this.scheduleTaskCandidateReconciliation(candidate);
        return;
      }
      if (!candidate.terminal && !assignment.nativeTurnId && candidate.observedTurns.length > 0) {
        if (!recovery.assignmentTurnId) {
          this.scheduleTaskCandidateReconciliation(candidate);
          return;
        }
        assignment = { ...assignment, nativeTurnId: recovery.assignmentTurnId };
        candidate.nativeTurnId = recovery.assignmentTurnId;
      }
      let state = this.parentStates.get(parentThreadId);
      if (state && state.requesterSessionKey !== candidate.requesterSessionKey) {
        return;
      }
      if (!state) {
        // A requester-scoped task row survives Codex parent rotation. thread/read
        // restores that old lineage; an existing foreign requester above still wins.
        state = {
          parentThreadId,
          owners: new Map(),
          turnIds: new Set(),
          deliveryReceipts:
            parentThreadId === candidate.parentState.parentThreadId
              ? candidate.deliveryReceipts
              : new CodexNativeSubagentDeliveryReceipts(),
          requesterSessionKey: candidate.requesterSessionKey,
          taskRuntimeScope: candidate.taskRuntimeScope,
          agentId: candidate.agentId,
          ...(parentThreadId === candidate.parentState.parentThreadId
            ? { historyOwner: candidate.parentState.historyOwner }
            : {}),
          taskRuntime: candidate.taskRuntime,
        };
        this.prepareParentTaskRuntime(state);
        this.parentStates.set(parentThreadId, state);
      }
      const observedTurns =
        parentThreadId === candidate.parentState.parentThreadId
          ? candidate.observedTurns.map((turn) => ({
              turnId: turn.turnId,
              state:
                turn.state && turn.state !== "active"
                  ? turn.state
                  : (recovery.observedPendingTurns.find(
                      (observed) => observed.turnId === turn.turnId,
                    )?.state ?? turn.state),
            }))
          : [];
      const childState = this.registerChildThread(state, assignment, {
        ...(recovery.agentPath ? { agentPath: recovery.agentPath } : {}),
        observedTurns,
      });
      if (!childState) {
        this.pruneParentIfUnused(state);
        return;
      }
      candidate.observedTurns.length = 0;
      this.recordRecoveredChildTurn(state, childState, recovery);
      if (recovery.threadState === "active") {
        this.observeActiveChild(childState);
      }
      if (recovery.threadState === "other") {
        this.clearSystemErrorFallback(childState);
      }
      if (recovery.resumable) {
        this.settleResumableChild(childState);
        return;
      }
      const completion = recovery.completion;
      if (!completion) {
        if (recovery.fallbackCompletion) {
          this.setRecoveryFallback(
            childState,
            recovery.fallbackCompletion,
            recovery.fallbackCompletion.completedAt ?? this.now(),
          );
          return;
        }
        this.scheduleRecoveryPoll(childState);
        return;
      }
      if (isNoFinalCompletion(completion)) {
        this.setRecoveryFallback(childState, completion, completion.completedAt ?? this.now());
        return;
      }
      await this.processCompletion(state, childState, completion, completion.completedAt);
    } finally {
      statusRead.release();
    }
  }

  private shouldReconcileCodexNativeTask(task: AgentHarnessTaskRecord): boolean {
    if (
      task.status === "queued" ||
      task.status === "running" ||
      task.deliveryStatus === "pending"
    ) {
      return true;
    }
    if (task.deliveryStatus !== "not_applicable" || task.endedAt === undefined) {
      return false;
    }
    return task.endedAt >= this.now() - RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS;
  }

  private logRecoveryFailure(childThreadId: string, error: unknown): void {
    embeddedAgentLog.debug("Codex native subagent history is not ready", {
      childThreadId,
      error: formatErrorMessage(error),
    });
  }
}

export const codexNativeSubagentMonitorRuntime = {
  Monitor,
  register: registerMonitor,
  retireParent: (client: CodexAppServerClient, parentThreadId: string): void => {
    monitors.get(client)?.retireParent(parentThreadId);
  },
};

function readThreadTurnRecovery(
  thread: JsonObject,
  childThreadId: string,
): Pick<ThreadRecovery, "completion" | "resumable" | "nativeTurnId" | "nativeTurnState"> {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!isJsonObject(turn)) {
      continue;
    }
    const status = normalizeIdentifier(readString(turn, "status"));
    return {
      nativeTurnId: readString(turn, "id"),
      nativeTurnState: readNativeTurnState(turn),
      completion: readTurnCompletion(turn, childThreadId),
      resumable: status === "interrupted",
    };
  }
  return { resumable: false };
}

function readNativeTurnEnd(turn: Record<string, unknown> | undefined): NativeTurnEnd | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  return status === "completed" || status === "failed" || status === "interrupted"
    ? status
    : undefined;
}

function readNativeTurnState(
  turn: Record<string, unknown> | undefined,
): NativeTurnState | undefined {
  return normalizeIdentifier(readString(turn, "status")) === "inprogress"
    ? "active"
    : readNativeTurnEnd(turn);
}

function readNativeTaskAssignment(
  task: AgentHarnessTaskRecord,
): (NativeSubagentAssignment & { initialTurnId?: string }) | undefined {
  const runId = task.runId;
  const identity = readCodexNativeSubagentRunId(runId);
  if (!runId || !identity) {
    return undefined;
  }
  const storedTurnId = isJsonObject(task.detail)
    ? normalizeOptionalString(readString(task.detail, "nativeTurnId"))
    : undefined;
  return {
    runId,
    childThreadId: identity.threadId,
    nativeTurnId: storedTurnId ?? identity.turnId,
    initialTurnId: identity.turnId,
  };
}

function toChildTurnCompletion(
  childState: ChildState,
  turn: JsonObject,
): CodexNativeSubagentCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "completed") {
    const turnId = readString(turn, "id");
    const result = turnId ? lastChildAssistantMessage(childState, turnId) : undefined;
    return {
      childThreadId: childState.childThreadId,
      status: "succeeded",
      statusLabel: result ? "turn_completed" : "completed_without_final_message",
      result: result ?? "Subagent completed without a final assistant message.",
    };
  }
  if (status === "failed") {
    return {
      childThreadId: childState.childThreadId,
      status: "failed",
      statusLabel: "turn_failed",
      result: readTurnErrorMessage(turn) ?? "Subagent failed.",
    };
  }
  return undefined;
}

function lastChildAssistantMessage(childState: ChildState, turnId: string): string | undefined {
  const messages = childState.assistantMessagesByTurn.get(turnId);
  if (!messages) {
    return undefined;
  }
  for (const itemId of messages.order.toReversed()) {
    if (messages.finalMessageIds.has(itemId) && !messages.commentaryIds.has(itemId)) {
      const text = normalizeOptionalString(messages.texts.get(itemId));
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function readTurnErrorMessage(turn: JsonObject): string | undefined {
  const error = isJsonObject(turn.error) ? turn.error : undefined;
  return (
    normalizeOptionalString(readString(error, "message")) ??
    normalizeOptionalString(
      isJsonObject(error?.codexErrorInfo) ? readString(error.codexErrorInfo, "message") : undefined,
    )
  );
}

function systemErrorFallbackCompletion(childThreadId: string): RecoveredCompletion {
  return {
    childThreadId,
    status: "failed",
    statusLabel: "system_error",
    result: "Subagent runtime reported a system error.",
  };
}

function readTurnCompletion(
  turn: JsonObject,
  childThreadId: string,
): RecoveredCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "inprogress" || !status) {
    return undefined;
  }
  const result = readLastAgentMessage(turn);
  const completedAtSeconds = asFiniteNumber(turn.completedAt);
  const completedAt =
    completedAtSeconds === undefined ? undefined : Math.round(completedAtSeconds * 1_000);
  if (status === "completed") {
    return {
      childThreadId,
      status: "succeeded",
      statusLabel: result ? "task_complete" : "completed_without_final_message",
      result: result ?? "Subagent completed without a final assistant message.",
      completedAt,
    };
  }
  // Codex keeps interrupted subagents resumable. They remain a running task
  // until a later turn reaches an authoritative terminal state.
  if (status === "interrupted") {
    return undefined;
  }
  if (status === "failed") {
    return {
      childThreadId,
      status: "failed",
      statusLabel: "task_failed",
      result: readTurnErrorMessage(turn) ?? result ?? "Subagent failed.",
      completedAt,
    };
  }
  return undefined;
}

function readLastAgentMessage(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  let legacyResult: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isJsonObject(item)) {
      continue;
    }
    if (normalizeIdentifier(readString(item, "type")) !== "agentmessage") {
      continue;
    }
    const text = readString(item, "text")?.trim();
    if (!text) {
      continue;
    }
    const phase = normalizeIdentifier(readString(item, "phase"));
    if (phase === "finalanswer") {
      return text;
    }
    if (!phase) {
      legacyResult ??= text;
    }
  }
  return legacyResult;
}

function buildParentAgentPathKey(parentThreadId: string, agentPath: string): string {
  return `${parentThreadId}\0${agentPath}`;
}

function isNoFinalCompletion(completion: CodexNativeSubagentCompletion): boolean {
  return (
    completion.status === "succeeded" &&
    completion.statusLabel === "completed_without_final_message"
  );
}

function delayForAttempt(delays: readonly number[], attempt: number): number {
  return Math.max(1, delays[Math.min(attempt, delays.length - 1)] ?? 1);
}

function readThreadParentThreadId(thread: JsonObject | undefined): string | undefined {
  return (
    readString(thread, "parentThreadId")?.trim() ??
    readString(readThreadSpawnSource(thread), "parent_thread_id")?.trim()
  );
}

function readThreadSpawnSource(thread: JsonObject | undefined): JsonObject | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  return isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readObjectStringKeys(value: JsonValue | undefined): string[] {
  return isJsonObject(value) ? Object.keys(value).filter((entry) => entry.trim() !== "") : [];
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
