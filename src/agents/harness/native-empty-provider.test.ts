import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validatePluginApprovalRequestParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/plugin-test-runtime.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  requireActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { OpenClawPluginDefinition, OpenClawPluginService } from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createEmptyAgentDiscoveryStores } from "../embedded-agent-runner/model.js";
import { resolveEmbeddedRunModelSetup } from "../embedded-agent-runner/run/model-setup.js";
import { capturePreparedModelRuntimeCatalog } from "../prepared-model-runtime.capture.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { prepareAgentRuntimeAuth } from "../runtime-plan/prepare-auth.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../timeout.js";
import * as gatewayTools from "../tools/gateway.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { registerAgentHarness } from "./registry.js";
import { selectAgentHarness, selectAgentHarnessForPreparedModelProviders } from "./selection.js";
import { projectPreparedModelProvider } from "./support.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
beforeEach(() => {
  snapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
});
afterEach(() => {
  restoreActivePluginRegistrySnapshot(snapshot);
  vi.restoreAllMocks();
});

const permissionRequest = {
  sessionId: "native-conversation",
  inferredKind: "execute",
  raw: {
    sessionId: "native-conversation",
    toolCall: {
      toolCallId: "native-bash",
      title: "Run the requested command",
      kind: "execute",
      rawInput: { command: `printf '%s' '${"reviewable argument ".repeat(60)}'` },
    },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Deny", kind: "reject_once" },
    ],
  },
};
type NativeTurn = Parameters<NonNullable<AcpRuntime["startTurn"]>>[0] & {
  onPermissionRequest?: (
    request: typeof permissionRequest,
    context: { signal: AbortSignal },
  ) => Promise<unknown>;
};

async function registerNativeRuntime(approval = false) {
  const handle = {
    sessionKey: "native-conversation",
    backend: "acpx",
    runtimeSessionName: "native-conversation",
  };
  const startTurn = vi.fn((turn: NativeTurn) => ({
    requestId: turn.requestId,
    promptStarted: Promise.resolve(),
    events: (async function* () {
      if (approval) {
        if (!turn.onPermissionRequest) {
          throw new Error("Native turn requires its permission callback");
        }
        expect(
          await turn.onPermissionRequest(permissionRequest, {
            signal: turn.signal ?? new AbortController().signal,
          }),
        ).toEqual({ outcome: "allow_once" });
      }
      yield { type: "text_delta" as const, text: "Native answer" };
    })(),
    result: Promise.resolve({ status: "completed" as const }),
    cancel: async () => {},
    closeStream: async () => {},
  }));
  const runtime = {
    inspectAgent: async (agent: string) => ({
      id: agent,
      name: "OpenCode",
      launch: { kind: "installed" as const, argv: ["/fixture/bin/opencode", "acp"] },
    }),
    ensureSession: vi.fn(async () => handle),
    findSession: async () => handle,
    startTurn,
    async *runTurn() {},
    getStatus: async () => ({
      models: {
        currentModelId: selection.modelId,
        availableModelIds: [selection.modelId],
        availableModels: [{ modelId: selection.modelId, name: "Native fixture" }],
      },
    }),
    getCapabilities: async () => ({ controls: [] }),
    setMode: async () => {},
    setModel: async () => {},
    setConfigOption: async () => {},
    doctor: async () => ({ ok: true, message: "ready" }),
    prepareFreshSession: async () => {},
    cancel: async () => {},
    close: async () => {},
    shutdown: async () => {},
  };
  const service = await loadBundledPluginFacade<{
    createAcpxRuntimeService: () => OpenClawPluginService & {
      getRuntime: () => Promise<typeof runtime>;
    };
  }>({ pluginId: "acpx", artifactBasename: "register.runtime.js" });
  vi.spyOn(service, "createAcpxRuntimeService").mockReturnValue({
    id: "acpx",
    start: async () => {},
    getRuntime: async () => runtime,
  });
  const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "acpx",
    artifactBasename: "index.js",
  });
  if (!plugin.register) {
    throw new Error("ACPX must expose its runtime registration");
  }
  plugin.register(
    createTestPluginApi({
      id: "acpx",
      config: {},
      runtime: createPluginRuntimeMock(),
      registerAgentHarness: (harness) => registerAgentHarness(harness, { ownerPluginId: "acpx" }),
    }),
  );
  return { runtime, startTurn };
}

const selection = {
  provider: "acp-opencode",
  modelId: "native-only-fixture",
  config: {},
  agentHarnessRuntimeOverride: "acp-opencode",
};

it.each([false, true])(
  "runs the registered native-only model with no host credential (approval=%s)",
  async (approval) => {
    const gateway = vi
      .spyOn(gatewayTools, "callGatewayTool")
      .mockResolvedValueOnce({ id: "approval" })
      .mockResolvedValueOnce({ id: "approval", decision: "allow-once", terminalReason: "user" });
    const native = await registerNativeRuntime(approval);
    const initial = selectAgentHarness(selection);
    const auth = prepareAgentRuntimeAuth({
      ...selection,
      env: {},
      authProfileStore: { version: 1, profiles: {} },
      harnessId: initial.id,
      harnessRuntime: initial.id,
      harnessAuthBootstrap: initial.authBootstrap,
    });
    expect(auth.attempts.map((attempt) => attempt.kind)).toEqual(["implicit"]);
    expect(auth.plan.forwardedAuthProfileId).toBeUndefined();
    const harness = selectAgentHarnessForPreparedModelProviders({
      ...selection,
      modelProviders: auth.attempts.map((attempt) =>
        projectPreparedModelProvider({ plan: attempt.plan, attemptKind: attempt.kind }),
      ),
    });
    expect(harness.id).toBe("acp-opencode");
    await withOpenClawTestState({ label: "native-empty-provider" }, async (state) => {
      await fs.writeFile(
        path.join(state.workspaceDir, "AGENTS.md"),
        "Use the current user request.\n",
      );
      const prompt = "Remember TAMARIND for this conversation. Reply only: Remembered TAMARIND.";
      const target = {
        agentId: "main",
        sessionKey: "agent:main:chat",
        sessionId: "conversation",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = { sessionId: target.sessionId, updatedAt: Date.now() };
      await upsertSessionEntry({ ...target, entry });
      const config = { session: { store: target.storePath } };
      if (!harness.loadModelCatalog) {
        throw new Error("Native harness must publish its models");
      }
      const entries = await harness.loadModelCatalog({
        config,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
      });
      const stores = createEmptyAgentDiscoveryStores();
      const prepared: PreparedModelRuntimeSnapshot = {
        catalogOwner: undefined,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        activeProjectKeys: [],
        config,
        observationConfig: config,
        isCurrent: () => true,
        authModes: {},
        metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
        pluginRegistry: requireActivePluginRegistry(),
        allowGatewaySubagentBinding: false,
        modelCatalog: { entries: [], routeVariants: [] },
        readFullModelCatalog: () => ({
          entries: approval ? [] : [...entries],
          routeVariants: [...entries],
        }),
        inlineProviderModels: [],
        configuredRuntimeModels: [],
        createStores: () => stores,
      };
      const captured = capturePreparedModelRuntimeCatalog(prepared, prepared);
      const setup = await withPluginRuntimeGenerationScope(captured, () =>
        resolveEmbeddedRunModelSetup({
          runParams: {
            ...selection,
            ...target,
            config,
            runId: "native-empty-provider",
            workspaceDir: state.workspaceDir,
            prompt,
            timeoutMs: 30000,
          },
          provider: selection.provider,
          modelId: selection.modelId,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          globalLane: "test",
          hookRunner: undefined,
          hookContext: { sessionId: target.sessionId, workspaceDir: state.workspaceDir },
          onHooksResolved: () => {},
          preparedModelRuntime: captured,
        }),
      );
      expect(setup.nativeModelOwned).toBe(true);
      expect(setup.nativeSessionRuntime).toBeUndefined();
      const authority = await createAdmittedHostCapabilityTestFixture({
        ...target,
        runId: "native-empty-provider",
        config,
      });
      try {
        const input: AgentHarnessAttemptParamsV2 = {
          ...target,
          config,
          runId: "native-empty-provider",
          workspaceDir: state.workspaceDir,
          sessionFile: "sqlite://conversation",
          provider: selection.provider,
          modelId: selection.modelId,
          prompt,
          currentInboundContext: {
            text: "Quoted earlier message: The fruit was mango.",
            promptJoiner: "\n",
          },
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
          thinkLevel: "off",
          model: setup.model,
          get authStorage(): never {
            throw new Error("Native inference must not read host auth");
          },
          get authProfileStore(): never {
            throw new Error("Native inference must not read host profiles");
          },
          get modelRegistry(): never {
            throw new Error("Native inference must not resolve an API model");
          },
          hostCapabilities: authority.hostCapabilities,
          userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
            message: { role: "user", content: prompt, timestamp: Date.now() },
            target: { ...target, sessionEntry: entry },
            updateMode: "none",
          }),
        };
        expect(await harness.runAttempt(input)).toMatchObject({ terminal: { kind: "ok" } });
        expect(native.startTurn).toHaveBeenCalledOnce();
        if (approval) {
          expect(gateway).toHaveBeenCalledTimes(2);
          const request = gateway.mock.calls[0]![2];
          if (!validatePluginApprovalRequestParams(request)) {
            throw new Error(JSON.stringify(validatePluginApprovalRequestParams.errors));
          }
          expect(request.detail).toBe(JSON.stringify(permissionRequest.raw.toolCall));
          expect(request.description).toBe(permissionRequest.raw.toolCall.title);
          expect(request.timeoutMs).toBe(120_000);
        }
        const sent = native.startTurn.mock.calls[0]![0].text;
        expect(sent).toContain(prompt);
        expect(sent).not.toMatch(/^\s*\//);
        expect(sent).toContain(`Quoted earlier message: The fruit was mango.\n${prompt}`);
        expect(native.runtime.ensureSession).toHaveBeenCalledWith(
          expect.objectContaining({
            agent: "opencode",
            agentCommand: ["/fixture/bin/opencode", "acp"],
            model: selection.modelId,
          }),
        );
      } finally {
        authority.closeHost();
        authority.closeAdmission();
      }
    });
  },
);

it.each(["endpoint", "transport", "profile", "policy"] as const)(
  "rejects incompatible %s facts through registered native selection",
  async (kind) => {
    const native = await registerNativeRuntime();
    const config: OpenClawConfig =
      kind === "endpoint"
        ? {
            models: {
              providers: {
                [selection.provider]: { baseUrl: "https://custom.example.invalid", models: [] },
              },
            },
          }
        : {};
    expect(() =>
      selectAgentHarnessForPreparedModelProviders({
        ...selection,
        config,
        modelProviders: [
          {
            ...(kind === "transport" ? { requestTransportOverrides: "present" as const } : {}),
            ...(kind === "profile" ? { preparedAuth: { source: "profile" as const } } : {}),
            ...(kind === "policy" ? { runtimePolicy: { compatibleIds: ["openclaw"] } } : {}),
          },
        ],
      }),
    ).toThrow(/cannot use an OpenClaw credential or custom provider transport/);
    expect(native.startTurn).not.toHaveBeenCalled();
  },
);
