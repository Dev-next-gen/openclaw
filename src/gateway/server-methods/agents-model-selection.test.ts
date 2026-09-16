import { beforeEach, describe, expect, it, vi } from "vitest";
import type { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";

const fixture = vi.hoisted(() => {
  const config: OpenClawConfig = {};
  return {
    config,
    writes: vi.fn(),
    beforeWrite: vi.fn(),
    choice: vi.fn<typeof preparePublishedModelRuntimeChoice>(),
  };
});

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  mutateConfigFileWithRetry: async (params: {
    mutate: (draft: OpenClawConfig) => Promise<void>;
    writeOptions?: { assertConfigPathForWrite?: () => void };
  }) => {
    const draft = structuredClone(fixture.config);
    await params.mutate(draft);
    fixture.beforeWrite();
    params.writeOptions?.assertConfigPathForWrite?.();
    fixture.writes(draft);
    fixture.config = draft;
  },
}));
vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: fixture.choice,
}));

const { agentsHandlers } = await import("./agents.js");
async function update(params: Record<string, unknown>) {
  const respond = vi.fn();
  await agentsHandlers["agents.update"]!({
    req: { type: "req", id: "native-selection", method: "agents.update" },
    params,
    respond,
    context: createDirectChatContext({ getRuntimeConfig: () => fixture.config }),
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.config = { agents: { entries: { main: {} } } };
  fixture.beforeWrite.mockReset();
  fixture.choice.mockReset().mockImplementation(async ({ runtimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? "openclaw",
    validate: () => undefined,
  }));
});

describe("agents.update native model selection", () => {
  it.each(["opencode", "qwen", "pi", "kilocode"])(
    "persists %s model and runtime without a verification claim",
    async (agent) => {
      const runtime = `acp-${agent}`;
      const model = `${runtime}/fixture-model`;
      const respond = await update({ agentId: "main", model, agentRuntime: runtime });
      expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "main" }, undefined);
      expect(fixture.config.agents?.entries?.main).toMatchObject({
        model,
        models: { [model]: { agentRuntime: { id: runtime } } },
      });
      expect(fixture.config.auth).toBeUndefined();
      expect(fixture.config.wizard).toBeUndefined();
    },
  );

  it("writes the implicit default without creating an agent roster", async () => {
    fixture.config = {};
    const respond = await update({
      agentId: "main",
      model: "acp-opencode/fixture-model",
      agentRuntime: "acp-opencode",
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "main" }, undefined);
    expect(fixture.config.agents?.entries).toBeUndefined();
    expect(fixture.config.agents?.list).toBeUndefined();
    expect(fixture.config.agents?.defaults).toMatchObject({
      model: "acp-opencode/fixture-model",
      models: { "acp-opencode/fixture-model": { agentRuntime: { id: "acp-opencode" } } },
    });
  });

  it.each(["sign-in required", "model catalog is unavailable"])(
    "preserves the default when %s",
    async (message) => {
      const before = structuredClone(fixture.config);
      fixture.choice.mockResolvedValue({ kind: "unavailable", message });
      const respond = await update({
        agentId: "main",
        model: "acp-opencode/fixture-model",
        agentRuntime: "acp-opencode",
      });
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ message }));
      expect(fixture.writes).not.toHaveBeenCalled();
      expect(fixture.config).toEqual(before);
    },
  );

  it("rejects a replaced catalog at the final config write", async () => {
    let current = true;
    fixture.choice.mockResolvedValue({
      kind: "ready",
      runtimeId: "acp-opencode",
      validate: () => (current ? undefined : "catalog replaced"),
    });
    fixture.beforeWrite.mockImplementation(() => {
      current = false;
    });
    const respond = await update({
      agentId: "main",
      model: "acp-opencode/fixture-model",
      agentRuntime: "acp-opencode",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "catalog replaced" }),
    );
    expect(fixture.writes).not.toHaveBeenCalled();
  });

  it.each(["openai/gpt-4.1", "openai/gpt-4.1@work", null])(
    "preserves legacy model setter semantics for %s without a catalog",
    async (model) => {
      fixture.config = { agents: { entries: { main: { model: "old/model" } } } };
      const respond = await update({ agentId: "main", model });
      expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "main" }, undefined);
      expect(fixture.config.agents?.entries?.main?.model).toBe(model ?? undefined);
      expect(fixture.choice).not.toHaveBeenCalled();
    },
  );

  it("keeps an explicitly empty roster empty", async () => {
    fixture.config = { agents: { entries: {} } };
    const respond = await update({
      agentId: "main",
      model: "acp-opencode/fixture-model",
      agentRuntime: "acp-opencode",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not found") }),
    );
    expect(fixture.writes).not.toHaveBeenCalled();
  });

  it("rejects combined runtime and workspace updates before filesystem effects", async () => {
    const respond = await update({
      agentId: "main",
      workspace: "/must-not-create",
      model: "acp-opencode/fixture-model",
      agentRuntime: "acp-opencode",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Runtime selection requires a model-only update." }),
    );
    expect(fixture.choice).not.toHaveBeenCalled();
    expect(fixture.writes).not.toHaveBeenCalled();
  });
});
