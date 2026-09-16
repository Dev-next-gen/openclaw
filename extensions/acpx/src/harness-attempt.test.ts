import path from "node:path";
import type { AcpRuntimeTurnInput as AcpxTurnInput } from "acpx/runtime";
import {
  resolveActiveEmbeddedRunSessionId,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createAdmittedHostCapabilityTestFixture,
  createPluginRuntimeMock,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { assert, expect, it, vi } from "vitest";
import type { AcpRuntimeEvent } from "../runtime-api.js";
import { runAcpHarnessAttempt } from "./harness-attempt.js";
import { createAcpAgentHarness } from "./harness.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

type Attempt = AgentHarnessAttemptParamsV2;
type NativeTurn = Parameters<CompleteAcpRuntime["startTurn"]>[0] &
  Pick<AcpxTurnInput, "onPermissionRequest">;
type Host = Attempt["hostCapabilities"];

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ label: "acpx-harness" }, async (state) => {
    const fixture = await makeFixture(state.workspaceDir, state.sessionsDir());
    try {
      await run(fixture);
    } finally {
      fixture.close();
    }
  });
}

async function makeFixture(workspaceDir: string, sessionsDir: string) {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:chat",
    sessionId: "conversation",
    storePath: path.join(sessionsDir, "sessions.json"),
  };
  const entry = { sessionId: target.sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({ ...target, entry });
  const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  const authorities: Array<() => void> = [];
  const handle = {
    sessionKey: "agent:main:harness:acp-opencode:conversation",
    backend: "acpx",
    runtimeSessionName: "adapter-handle",
    backendSessionId: "adapter-session",
  };
  let lastRequestId: string | undefined;
  let sequence = 0;
  const script = {
    async *events(_turn: NativeTurn): AsyncGenerator<AcpRuntimeEvent> {
      yield { type: "text_delta", text: "Answer" };
    },
  };
  const startTurn = vi.fn((turn: NativeTurn) => {
    lastRequestId = turn.requestId;
    const result = createDeferred<Awaited<ReturnType<CompleteAcpRuntime["startTurn"]>["result"]>>();
    return {
      requestId: turn.requestId,
      promptStarted: Promise.resolve(),
      events: (async function* () {
        try {
          yield* script.events(turn);
        } finally {
          result.resolve({ status: turn.signal?.aborted ? "cancelled" : "completed" });
        }
      })(),
      result: result.promise,
      cancel: vi.fn(async () => {}),
      closeStream: vi.fn(async () => {}),
    };
  });
  const inspectAgent = vi.fn<CompleteAcpRuntime["inspectAgent"]>(async () => ({
    id: "opencode",
    name: "OpenCode",
    launch: { kind: "installed", argv: ["/fixture/bin/opencode", "acp"] },
  }));
  const runtime: CompleteAcpRuntime = {
    inspectAgent,
    ensureSession: vi.fn(async () => handle),
    findSession: async () => handle,
    startTurn,
    async *runTurn() {},
    getCapabilities: async () => ({ controls: [] }),
    getStatus: async () => ({
      lastRequestId,
      models: { currentModelId: "model", availableModelIds: ["model"] },
    }),
    setMode: async () => {},
    setModel: vi.fn(async () => {}),
    setConfigOption: async () => {},
    doctor: async () => ({ ok: true, message: "ready" }),
    prepareFreshSession: async () => {},
    cancel: async () => {},
    close: vi.fn(async () => {}),
    shutdown: async () => {},
  };
  const prepare = async (prompt: string) => {
    const runId = `run-${++sequence}`;
    const config = { session: { store: target.storePath } };
    const authority = await createAdmittedHostCapabilityTestFixture({ ...target, runId, config });
    authorities.push(() => {
      authority.closeHost();
      authority.closeAdmission();
    });
    const requestApproval = vi.fn<Host["requestApproval"]>(async () => ({ id: "approval" }));
    const waitForApproval = vi.fn<Host["waitForApproval"]>(async () => ({
      decision: "deny",
      terminalReason: "user",
    }));
    const input: Attempt = {
      ...target,
      config,
      workspaceDir,
      sessionFile: "sqlite://conversation",
      runId,
      prompt,
      provider: "acp-opencode",
      modelId: "model",
      timeoutMs: 30_000,
      thinkLevel: "off",
      model: {
        id: "model",
        name: "Model",
        provider: "acp-opencode",
        api: "openai-responses",
        baseUrl: "https://example.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
      get authStorage(): never {
        throw new Error("Native chat must not read host auth storage");
      },
      get authProfileStore(): never {
        throw new Error("Native chat must not read host credentials");
      },
      get modelRegistry(): never {
        throw new Error("Native chat must not resolve another model");
      },
      hostCapabilities: { ...authority.hostCapabilities, requestApproval, waitForApproval },
      userTurnTranscriptRecorder: createRecorder({
        message: { role: "user", content: prompt, timestamp: Date.now() },
        target: { ...target, sessionEntry: entry },
        updateMode: "none",
      }),
      onPartialReply: vi.fn(async () => {}),
    };
    return { input, requestApproval, waitForApproval, revoke: authority.closeHost };
  };
  return {
    target,
    runtime,
    inspectAgent,
    startTurn,
    script,
    prepare,
    read: () => readVisibleSessionTranscriptMessageEntries(target),
    run: (input: Attempt) =>
      runAcpHarnessAttempt({
        input,
        runtime,
        agent: "opencode",
        harnessId: "acp-opencode",
        label: "OpenCode",
        command: ["opencode", "acp"],
        generationSignal: new AbortController().signal,
      }),
    close: () => {
      for (const close of authorities) {
        close();
      }
    },
  };
}

async function permission(turn: NativeTurn, title = "Edit document") {
  if (!turn.onPermissionRequest) {
    throw new Error("Prompt must carry its permission owner");
  }
  const decision = await turn.onPermissionRequest(
    {
      sessionId: "adapter-session",
      inferredKind: "edit",
      raw: {
        sessionId: "adapter-session",
        toolCall: { toolCallId: "edit", title, kind: "edit" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      },
    },
    { signal: turn.signal ?? AbortSignal.abort() },
  );
  if (!decision) {
    throw new Error("Host permission must return an explicit decision");
  }
  return decision;
}

it.each([undefined, "full"] as const)(
  "runs a freshly selected harness without prior catalog acquisition (permission mode=%s)",
  async (permissionMode) => {
    await withFixture(async (f) => {
      const harness = createAcpAgentHarness({
        agent: "opencode",
        label: "OpenCode",
        api: createTestPluginApi({ runtime: createPluginRuntimeMock() }),
        getRuntime: async () => f.runtime,
        shutdown: async () => {},
      });
      const { input } = await f.prepare("Use the selected runtime");
      input.permissionMode = permissionMode;
      const result = await harness.runAttempt(input);
      expect(result).toMatchObject({
        terminal: { kind: "ok" },
        currentAttemptAssistant: { __openclaw: { runId: input.runId } },
      });
      const assistants = (await f.read()).filter((entry) => entry.role === "assistant");
      expect(assistants).toHaveLength(1);
      const [assistant] = assistants;
      assert(assistant);
      expect(assistant.message).toEqual(result.currentAttemptAssistant);
      expect(assistant.idempotencyKey).toBe(result.assistantTranscriptIdempotencyKey);
      expect(assistant.idempotencyKey).not.toBe(input.runId);
      expect(f.runtime.ensureSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentCommand: ["/fixture/bin/opencode", "acp"],
        }),
      );
      expect(f.startTurn).toHaveBeenCalledOnce();
    });
  },
);

it.each(["read-only", "guarded", "workspace"] as const)(
  "rejects unsupported host permission mode %s before acquiring the native runtime",
  async (permissionMode) => {
    await withFixture(async (f) => {
      const getRuntime = vi.fn(async () => f.runtime);
      const harness = createAcpAgentHarness({
        agent: "opencode",
        label: "OpenCode",
        api: createTestPluginApi({ runtime: createPluginRuntimeMock() }),
        getRuntime,
        shutdown: async () => {},
      });
      const { input } = await f.prepare("Perform the requested native tool action");
      input.permissionMode = permissionMode;
      await expect(harness.runAttempt(input)).rejects.toThrow(/cannot enforce.*permission mode/i);
      expect(f.inspectAgent).not.toHaveBeenCalled();
      expect(getRuntime).not.toHaveBeenCalled();
      expect(f.runtime.ensureSession).not.toHaveBeenCalled();
      expect(f.startTurn).not.toHaveBeenCalled();
      expect(await f.read()).toEqual([]);
    });
  },
);

it.each(["plain-model", "$runtime|openai|fixture-model(openai)", "vendor/nested/model"])(
  "forwards the opaque model %s through the registered harness",
  async (modelId) => {
    await withFixture(async (f) => {
      const harness = createAcpAgentHarness({
        agent: "opencode",
        label: "OpenCode",
        api: createTestPluginApi({ runtime: createPluginRuntimeMock() }),
        getRuntime: async () => f.runtime,
        shutdown: async () => {},
      });
      const { input } = await f.prepare("Use this native model");
      input.modelId = modelId;
      const result = await harness.runAttempt(input);
      expect(result).toMatchObject({
        terminal: { kind: "ok" },
        agentHarnessId: "acp-opencode",
        runtimeModelSelection: { provider: "acp-opencode", model: modelId },
      });
      expect(f.runtime.ensureSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:harness:acp-opencode:conversation",
          agent: "opencode",
          model: modelId,
        }),
      );
      expect(f.runtime.setModel).toHaveBeenCalledExactlyOnceWith({
        handle: expect.objectContaining({ backendSessionId: "adapter-session" }),
        model: modelId,
      });
      expect(f.startTurn).toHaveBeenCalledOnce();
    });
  },
);

it.each(["allow-once", "deny"] as const)(
  "waits for final %s after approval acknowledgment and bounds presentation",
  async (decision) => {
    await withFixture(async (f) => {
      const attempt = await f.prepare("Edit the document");
      const waiting = createDeferred<void>();
      const answer = createDeferred<Awaited<ReturnType<Host["waitForApproval"]>>>();
      attempt.requestApproval.mockResolvedValue({ id: "approval", decision: "allow-once" });
      attempt.waitForApproval.mockImplementation(async () => {
        waiting.resolve();
        return answer.promise;
      });
      let action: string | undefined;
      f.script.events = async function* (turn) {
        action = (await permission(turn, "\u001b[31mEdit\u001b[0m " + "long ".repeat(400))).outcome;
        yield { type: "text_delta", text: action === "allow_once" ? "Edited" : "Denied" };
      };
      const running = f.run(attempt.input);
      try {
        expect(
          await Promise.race([
            waiting.promise.then(() => "waiting"),
            running.then(() => "completed"),
          ]),
        ).toBe("waiting");
        expect(action).toBeUndefined();
        expect(attempt.waitForApproval).toHaveBeenCalledWith(
          expect.objectContaining({ approvalId: "approval" }),
        );
        const request = attempt.requestApproval.mock.calls[0]![0];
        expect(request.title.length).toBeLessThanOrEqual(80);
        expect(request.description.length).toBeLessThanOrEqual(512);
        expect(request.title).not.toContain("\u001b");
        answer.resolve({ decision, terminalReason: "user" });
        const result = await running;
        expect(action).toBe(decision === "allow-once" ? "allow_once" : "reject_once");
        expect(result).toMatchObject({ terminal: { kind: "ok" } });
        expect((await f.read()).map((row) => row.role)).toEqual(["user", "assistant"]);
        expect(f.runtime.close).not.toHaveBeenCalled();
      } finally {
        answer.resolve({ decision: "deny", terminalReason: "user" });
        await running;
      }
    });
  },
);

it.each([
  {
    name: "whitespace before a denied tool",
    text: "\n\n",
    denied: true,
    expected: "OpenCode could not complete this turn because permission was not granted.",
  },
  {
    name: "whitespace before a failed tool without denial",
    text: " \n\t",
    denied: false,
    expected: "OpenCode reported a failed tool operation and did not return an answer.",
  },
  {
    name: "a real answer before a denied tool",
    text: "\nThe edit was not applied.\n",
    denied: true,
    expected: "\nThe edit was not applied.\n",
  },
])("returns and saves a visible result for $name", async ({ text, denied, expected }) => {
  await withFixture(async (f) => {
    const attempt = await f.prepare("Edit the document once");
    f.script.events = async function* (turn) {
      yield { type: "text_delta", text };
      if (denied) {
        expect((await permission(turn)).outcome).toBe("reject_once");
      }
      yield {
        type: "tool_call",
        toolCallId: "edit",
        kind: "edit",
        status: "failed",
        text: denied ? "Permission was denied" : "File edit failed",
      };
    };
    const result = await f.run(attempt.input);
    expect(result).toMatchObject({ terminal: { kind: "ok" } });
    expect(result.assistantTexts).toEqual([expected]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: expected }]);
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(result.toolMetas).toEqual([
      expect.objectContaining({ toolCallId: "edit", isError: true }),
    ]);
    expect(attempt.requestApproval).toHaveBeenCalledTimes(denied ? 1 : 0);
    const saved = (await f.read()).find((row) => row.role === "assistant");
    expect(saved?.message).toEqual(
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: expected }] }),
    );
  });
});

it.each(["authority", "abort"] as const)(
  "rejects approval after %s closes while awaiting a final answer",
  async (kind) => {
    await withFixture(async (f) => {
      const attempt = await f.prepare("Edit the document");
      const controller = new AbortController();
      attempt.input.abortSignal = controller.signal;
      const waiting = createDeferred<void>();
      const answer = createDeferred<Awaited<ReturnType<Host["waitForApproval"]>>>();
      attempt.waitForApproval.mockImplementation(async () => {
        waiting.resolve();
        return answer.promise;
      });
      let action: string | undefined;
      f.script.events = async function* (turn) {
        action = (await permission(turn)).outcome;
        yield { type: "text_delta", text: "Late output" };
      };
      const running = f.run(attempt.input);
      try {
        expect(
          await Promise.race([
            waiting.promise.then(() => "waiting"),
            running.then(() => "completed"),
          ]),
        ).toBe("waiting");
        if (kind === "abort") {
          controller.abort();
        } else {
          attempt.revoke();
        }
        answer.resolve({ decision: "allow-once", terminalReason: "user" });
        const result = await running;
        expect(action).toBe("cancel");
        if (kind === "abort") {
          expect(result.terminal.kind).toBe("aborted");
        }
        expect(attempt.input.onPartialReply).not.toHaveBeenCalled();
        expect(result.assistantTexts).not.toContain("Late output");
        expect(resolveActiveEmbeddedRunSessionId(f.target.sessionKey)).toBeUndefined();
      } finally {
        answer.resolve({ decision: "deny", terminalReason: "user" });
        await running;
      }
    });
  },
);

it("keeps admitted turns continuous across cancellation and imports only intervening transcript messages", async () => {
  await withFixture(async (f) => {
    const first = await f.prepare("First question");
    const firstResult = await f.run(first.input);
    expect(firstResult.terminal.kind).toBe("ok");
    expect(f.startTurn.mock.calls[0]![0].text).toContain("First question");
    const firstReceipt = first.input.userTurnTranscriptRecorder!.getAdmissionReceipt()!;
    expect(f.startTurn.mock.calls[0]![0].requestId).toMatch(`${firstReceipt.entryId}:acp:`);
    const second = await f.prepare("Second question");
    expect((await f.run(second.input)).terminal.kind).toBe("ok");
    expect(f.startTurn.mock.calls[1]![0].text).toContain("Second question");
    expect(f.startTurn.mock.calls[1]![0].text).not.toContain("First question");
    expect(f.startTurn.mock.calls[1]![0].text).not.toContain(
      "Conversation context before this turn",
    );

    const cancelled = await f.prepare("Cancelled question");
    const controller = new AbortController();
    cancelled.input.abortSignal = controller.signal;
    f.script.events = async function* () {
      controller.abort();
      yield { type: "text_delta", text: "Hidden" };
    };
    expect((await f.run(cancelled.input)).terminal.kind).toBe("aborted");
    await appendSessionTranscriptMessageByIdentityStrict({
      ...f.target,
      message: {
        role: "user",
        content: "Message while using another runtime",
        timestamp: Date.now(),
      },
    });
    await appendSessionTranscriptMessageByIdentityStrict({
      ...f.target,
      message: {
        ...firstResult.lastAssistant,
        idempotencyKey: "other-runtime:assistant",
        __openclaw: { runId: "other-runtime" },
        content: [{ type: "text", text: "Other runtime answer" }],
      },
    });
    f.script.events = async function* () {
      yield { type: "text_delta", text: "Resumed answer" };
    };
    const next = await f.prepare("Next question");
    expect((await f.run(next.input)).terminal.kind).toBe("ok");
    const sent = f.startTurn.mock.calls[3]![0].text;
    expect(sent).toContain("Next question");
    expect(sent).toContain("Message while using another runtime");
    expect(sent).toContain("Other runtime answer");
    expect(sent).not.toContain("First question");
    expect(sent).not.toContain("Cancelled question");
    const rows = await f.read();
    expect(rows.filter((row) => row.role === "user")).toHaveLength(5);
    expect(JSON.stringify(rows)).not.toContain("Hidden");
    expect(f.runtime.close).not.toHaveBeenCalled();
  });
});

it.each(["clear", "retain"] as const)(
  "uses the canonical %s reset context when acquiring a fresh native session",
  async (context) => {
    await withFixture(async (f) => {
      const first = await f.prepare("Question before reset");
      expect((await f.run(first.input)).terminal.kind).toBe("ok");
      const retained = await f.prepare("Explicitly retained question");
      expect((await f.run(retained.input)).terminal.kind).toBe("ok");
      const retainedId = retained.input.userTurnTranscriptRecorder!.getAdmissionReceipt()!.entryId;
      SessionManager.open(f.target).appendResetBoundary(
        "reset",
        context === "retain" ? retainedId : undefined,
      );
      vi.spyOn(f.runtime, "getStatus").mockResolvedValue({
        models: { currentModelId: "model", availableModelIds: ["model"] },
      });
      const harness = createAcpAgentHarness({
        agent: "opencode",
        label: "OpenCode",
        api: createTestPluginApi({ runtime: createPluginRuntimeMock() }),
        getRuntime: async () => f.runtime,
        shutdown: async () => {},
      });
      const next = await f.prepare("Question after reset");
      const result = await harness.runAttempt(next.input);
      expect(result).toMatchObject({ terminal: { kind: "ok" } });
      const sent = f.startTurn.mock.calls[2]![0].text;
      expect(sent).toContain("Question after reset");
      expect(sent).not.toContain("Question before reset");
      expect(sent.includes("Explicitly retained question")).toBe(context === "retain");
      const snapshot = JSON.stringify(result.messagesSnapshot);
      expect(snapshot).not.toContain("Question before reset");
      expect(snapshot.includes("Explicitly retained question")).toBe(context === "retain");
      expect(JSON.stringify(await f.read())).toContain("Question before reset");
    });
  },
);

it("reconciles a native request outside the compacted model payload window", async () => {
  await withFixture(async (f) => {
    f.script.events = async function* () {
      yield { type: "text_delta", text: "Old native answer" };
    };
    const first = await f.prepare("Old native question");
    expect((await f.run(first.input)).terminal.kind).toBe("ok");
    const source = SessionManager.open(f.target);
    const retained = source.appendMessage({
      role: "user",
      content: "Intervening retained question",
      timestamp: Date.now(),
    });
    source.appendCompaction("Compacted conversation summary", retained, 100);
    const context = await SessionManager.openModelContextAsync(f.target);
    expect(JSON.stringify(context.buildSessionContext().messages)).not.toContain("Old native");
    expect(
      context
        .getBranch()
        .some(
          (entry) =>
            entry.id === first.input.userTurnTranscriptRecorder!.getAdmissionReceipt()!.entryId,
        ),
    ).toBe(true);
    f.script.events = async function* () {
      yield { type: "text_delta", text: "Current native answer" };
    };
    const harness = createAcpAgentHarness({
      agent: "opencode",
      label: "OpenCode",
      api: createTestPluginApi({ runtime: createPluginRuntimeMock() }),
      getRuntime: async () => f.runtime,
      shutdown: async () => {},
    });
    const next = await f.prepare("Continue after compaction");
    const result = await harness.runAttempt(next.input);
    expect(result).toMatchObject({ terminal: { kind: "ok" } });
    const sent = f.startTurn.mock.calls[1]![0].text;
    expect(sent).toContain("Compacted conversation summary");
    expect(sent).toContain("Intervening retained question");
    expect(sent).toContain("Continue after compaction");
    expect(sent).not.toContain("Old native");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Old native");
    expect(JSON.stringify(await f.read())).toContain("Old native question");
  });
});

it("does not submit when the prepared input has no transcript admission", async () => {
  await withFixture(async (f) => {
    const attempt = await f.prepare("Unadmitted");
    const recorder = attempt.input.userTurnTranscriptRecorder!;
    recorder.persistApproved = async () => undefined;
    expect((await f.run(attempt.input)).terminal).toMatchObject({
      kind: "failed",
      error: new Error("ACP input was not admitted to its transcript"),
    });
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(resolveActiveEmbeddedRunSessionId(f.target.sessionKey)).toBeUndefined();
  });
});

it("releases active-run registration when backend attachment throws", async () => {
  await withFixture(async (f) => {
    const attempt = await f.prepare("Attach the backend");
    const fail = () => {
      throw new Error("reply owner replaced");
    };
    const attachBackend = vi.fn(() => {
      expect(resolveActiveEmbeddedRunSessionId(f.target.sessionKey)).toBe(f.target.sessionId);
      fail();
    });
    attempt.input.replyOperation = {
      key: f.target.sessionKey,
      sessionId: f.target.sessionId,
      turnKind: "visible",
      abortSignal: new AbortController().signal,
      resetTriggered: false,
      terminalRecovery: false,
      acceptedSteeredInboundAudio: false,
      phase: "running",
      result: null,
      startedAtMs: 1,
      lastActivityAtMs: 1,
      attachBackend,
      hasOwnedSessionId: fail,
      captureOwnedSessionIds: fail,
      recordActivity: fail,
      setPhase: fail,
      markWaitingForDeferredMaintenance: fail,
      markDeferredMaintenanceWaitEnded: fail,
      markWaitingForGlobalLane: fail,
      markGlobalLaneWaitEnded: fail,
      markTerminalRecovery: fail,
      markAcceptedSteeredInboundAudio: fail,
      bindToolAuthoritySnapshot: fail,
      projectToolAuthorityFingerprint: fail,
      bindToolAuthorityRoute: fail,
      updateSessionId: fail,
      updateSessionKey: fail,
      detachBackend: fail,
      freezeAbort: fail,
      retainFailureUntilComplete: fail,
      complete: fail,
      completeThen: fail,
      completeWithAfterClearBarrier: fail,
      fail,
      abortByUser: fail,
      abortForRestart: fail,
      supersede: fail,
    };
    const result = await f.run(attempt.input);
    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: new Error("reply owner replaced"),
    });
    expect(attachBackend).toHaveBeenCalledOnce();
    expect(resolveActiveEmbeddedRunSessionId(f.target.sessionKey)).toBeUndefined();
    expect(f.runtime.ensureSession).not.toHaveBeenCalled();
    expect(await f.read()).toEqual([]);
  });
});

it.each(["abort", "authority"])(
  "does not resume first-output delivery after %s during setup",
  async (kind) => {
    await withFixture(async (f) => {
      const attempt = await f.prepare("Start reply");
      const controller = new AbortController();
      attempt.input.abortSignal = controller.signal;
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      attempt.input.onAssistantMessageStart = async () => {
        entered.resolve();
        await release.promise;
      };
      const running = f.run(attempt.input);
      await entered.promise;
      if (kind === "abort") {
        controller.abort();
      } else {
        attempt.revoke();
      }
      release.resolve();
      const result = await running;
      expect(attempt.input.onPartialReply).not.toHaveBeenCalled();
      expect(result.assistantTexts).toEqual([]);
      expect(JSON.stringify(await f.read())).not.toContain("Answer");
      expect(resolveActiveEmbeddedRunSessionId(f.target.sessionKey)).toBeUndefined();
    });
  },
);

it("records a visible continuation after an empty attempt without duplicating the admitted user", async () => {
  await withFixture(async (f) => {
    const attempt = await f.prepare("Remember TAMARIND");
    f.script.events = async function* () {};
    expect((await f.run(attempt.input)).terminal.kind).toBe("ok");
    f.script.events = async function* () {
      yield { type: "text_delta", text: "Remembered TAMARIND" };
    };
    attempt.input.prompt = "Produce the visible answer now";
    attempt.input.suppressNextUserMessagePersistence = true;
    expect((await f.run(attempt.input)).terminal.kind).toBe("ok");
    const requests = f.startTurn.mock.calls.map(([turn]) => turn.requestId);
    expect(requests[0]).not.toBe(requests[1]);
    const rows = await f.read();
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("Remembered TAMARIND");
    const next = await f.prepare("What did I ask you to remember?");
    expect((await f.run(next.input)).terminal.kind).toBe("ok");
    const sent = f.startTurn.mock.calls[2]![0].text;
    expect(sent).toContain("What did I ask you to remember?");
    expect(sent).not.toContain("Produce the visible answer now");
    expect(sent).not.toContain("Conversation context before this turn");
  });
});

it("reconciles a provider attempt that lost authority before committing its assistant", async () => {
  await withFixture(async (f) => {
    const first = await f.prepare("Read the document before editing it");
    f.script.events = async function* () {
      first.revoke();
      yield { type: "text_delta", text: "Uncommitted output" };
    };
    expect((await f.run(first.input)).terminal.kind).toBe("failed");
    expect((await f.read()).map((row) => row.role)).toEqual(["user"]);
    f.script.events = async function* () {
      yield { type: "text_delta", text: "Continued safely" };
    };
    const next = await f.prepare("Continue after checking the current state");
    expect((await f.run(next.input)).terminal.kind).toBe("ok");
    const sent = f.startTurn.mock.calls[1]![0].text;
    expect(sent).not.toContain("Read the document before editing it");
    expect(sent).toContain("Continue after checking the current state");
    expect(sent).not.toContain("Uncommitted output");
    expect((await f.read()).map((row) => row.role)).toEqual(["user", "user", "assistant"]);
  });
});

it("reports an unavailable approval instead of recording it as a user denial", async () => {
  await withFixture(async (f) => {
    const attempt = await f.prepare("Review the full action before running it");
    const failure = new Error("Approval detail exceeds the review display limit");
    attempt.requestApproval.mockRejectedValue(failure);
    f.script.events = async function* (turn) {
      expect((await permission(turn)).outcome).toBe("cancel");
      yield {
        type: "tool_call",
        toolCallId: "edit",
        kind: "edit",
        status: "failed",
        text: "Permission request cancelled",
      };
    };
    expect((await f.run(attempt.input)).terminal).toMatchObject({ kind: "failed", error: failure });
    expect(attempt.waitForApproval).not.toHaveBeenCalled();
    expect((await f.read()).map((row) => row.role)).toEqual(["user"]);
  });
});
