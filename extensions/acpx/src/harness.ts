import { randomUUID } from "node:crypto";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "../runtime-api.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

export function createAcpAgentHarness(params: {
  agent: string;
  label: string;
  shutdown: () => Promise<void> | void;
  api: OpenClawPluginApi;
  getRuntime: (context: OpenClawPluginServiceContext) => Promise<CompleteAcpRuntime>;
}): AgentHarnessV2 {
  const id = `acp-${params.agent}`;
  const generation = new AbortController();
  const runtimeFor = (workspaceDir?: string) =>
    params.getRuntime({
      config: params.api.config,
      workspaceDir,
      stateDir: params.api.runtime.state.resolveStateDir(),
      logger: params.api.logger,
    });
  const resource = (agentId: string, sessionId: string) =>
    `agent:${agentId}:harness:${id}:${sessionId}`;
  const retire = async (
    input: { agentId: string; sessionId: string; sessionKey: string },
    assertCurrent: () => void,
  ) => {
    const runtime = await runtimeFor();
    assertCurrent();
    const handle = await runtime.findSession({
      sessionKey: resource(input.agentId, input.sessionId),
      agent: params.agent,
      agentId: input.agentId,
    });
    assertCurrent();
    if (handle) {
      const ownedHandle = {
        ...handle,
        bridgeSession: { sessionKey: input.sessionKey, agentId: input.agentId, native: true },
      };
      await runtime.prepareFreshSession({ handle: ownedHandle });
    }
  };
  return {
    id,
    label: params.label,
    autoSelection: { providerIds: [] },
    authBootstrap: "harness",
    supports: ({ requestedRuntime, modelProvider }) => {
      if (requestedRuntime !== id) {
        return { supported: false, reason: `Choose ${params.label} explicitly` };
      }
      if (modelProvider?.endpointOverrides === undefined) {
        return { supported: false, reason: "Update OpenClaw to use this native runtime." };
      }
      if (
        modelProvider?.requestTransportOverrides === "present" ||
        modelProvider?.endpointOverrides === "present" ||
        modelProvider?.preparedAuth?.source === "profile" ||
        modelProvider?.preparedAuth?.source === "direct" ||
        (modelProvider?.runtimePolicy && !modelProvider.runtimePolicy.compatibleIds.includes(id))
      ) {
        return {
          supported: false,
          reason: `${params.label} owns its login and cannot use an OpenClaw credential or custom provider transport`,
        };
      }
      return { supported: true, priority: 100 };
    },
    async loadModelCatalog(input) {
      generation.signal.throwIfAborted();
      const runtime = await runtimeFor(input.workspaceDir);
      generation.signal.throwIfAborted();
      const inspection = await runtime.inspectAgent(params.agent);
      generation.signal.throwIfAborted();
      if (inspection?.launch.kind !== "installed") {
        return [];
      }
      const target = {
        agentId: input.agentId,
        sessionKey: resource(input.agentId, `catalog:${randomUUID()}`),
        agent: params.agent,
        agentCommand: inspection.launch.argv,
        cwd: input.workspaceDir,
        mode: "oneshot" as const,
        bridgeSession: null,
      };
      const handle = await runtime.ensureSession(target);
      try {
        const status = await runtime.getStatus({ handle, signal: generation.signal });
        generation.signal.throwIfAborted();
        return (status.models?.availableModels ?? []).map((model) => ({
          provider: id,
          id: model.modelId,
          name: model.name,
          nativeRuntime: id,
        }));
      } finally {
        await runtime.close({ handle, reason: "catalog-complete" });
      }
    },
    async runAttempt(input) {
      generation.signal.throwIfAborted();
      if (input.permissionMode && input.permissionMode !== "full") {
        throw new Error(
          `${params.label} cannot enforce this permission mode. Choose Full access or another runtime.`,
        );
      }
      const runtime = await runtimeFor(input.workspaceDir);
      generation.signal.throwIfAborted();
      const inspection = await runtime.inspectAgent(params.agent);
      generation.signal.throwIfAborted();
      if (inspection?.launch.kind !== "installed") {
        throw new Error(`${params.label} is not installed; refresh the model catalog`);
      }
      const { runAcpHarnessAttempt } = await import("./harness-attempt.js");
      return await runAcpHarnessAttempt({
        input,
        runtime,
        agent: params.agent,
        harnessId: id,
        label: params.label,
        command: inspection.launch.argv,
        generationSignal: generation.signal,
      });
    },
    async reset(input) {
      if (input.agentId && input.sessionId && input.sessionKey) {
        await retire(
          { agentId: input.agentId, sessionId: input.sessionId, sessionKey: input.sessionKey },
          () => generation.signal.throwIfAborted(),
        );
      }
    },
    async withSessionDeletion(input, run) {
      let committed = false;
      try {
        return await run({
          commit: () => {
            committed = true;
          },
          rollback: () => {
            committed = false;
          },
        });
      } finally {
        if (committed) {
          await retire(input, input.assertCurrent);
        }
      }
    },
    async dispose() {
      generation.abort();
      await params.shutdown();
    },
  };
}
