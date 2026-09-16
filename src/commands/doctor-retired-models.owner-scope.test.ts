import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRetiredModelFixture } from "./doctor-retired-models.test-support.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredSessionModelRef,
} from "./doctor/shared/retired-model-ref-repair.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";

async function nativeFixture() {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  const { state } = await createRetiredModelFixture();
  vi.stubEnv("XAI_API_KEY", undefined);
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "xai:fixture": { provider: "xai", type: "api_key", key: "synthetic-xai-key" },
    },
  });
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "Grok", fallbacks: ["xai/grok-4.3"] },
        models: { "xai/auto": { alias: "Grok", params: { temperature: 0.25 } } },
        modelPolicy: { allow: ["xai/auto", "xai/grok-4.3"] },
      },
    },
    auth: { order: { xai: ["xai:fixture"] } },
    models: {
      providers: {
        xai: {
          baseUrl: "https://api.x.ai/v1",
          api: "openai-responses",
          auth: "api-key",
          models: [],
        },
      },
    },
    plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
  };
  const repair = (config: OpenClawConfig) =>
    repairStaleAgentModelRefs(config, {
      env: state.env,
      pluginProviderIds: new Set(["xai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
  return { cfg, state, repair };
}

it("moves Grok and its policy to the successor when its only route is native xAI", async () => {
  const { cfg, repair } = await nativeFixture();
  const result = repair(cfg);

  expect(resolveDefaultModelForAgent({ cfg: result.config, agentId: "main" })).toEqual({
    provider: "xai",
    model: "grok-4.6",
  });
  expect(result.config.agents?.defaults?.model).toMatchObject({
    fallbacks: ["xai/grok-4.3"],
  });
  expect(result.config.agents?.defaults?.models).toEqual({
    "xai/grok-4.6": { alias: "Grok", params: { temperature: 0.25 } },
  });
  expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual([
    "xai/grok-4.6",
    "xai/grok-4.3",
  ]);
  expect(result.config.models).toEqual(cfg.models);
  expect(cfg.agents?.defaults?.models?.["xai/auto"]?.alias).toBe("Grok");
  const repeated = repair(result.config);
  expect(repeated.config).toEqual(result.config);
  expect(repeated.changes).toEqual([]);
  expect(repeated.warnings).toEqual([]);
});

it.each(["provider", "model"] as const)(
  "keeps Grok on an explicit custom %s endpoint under the xAI provider",
  async (endpointOwner) => {
    const { cfg, repair } = await nativeFixture();
    const customModel: ModelDefinitionConfig = {
      id: "auto",
      name: "Custom automatic model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
      ...(endpointOwner === "model" ? { baseUrl: "https://custom.example.test/v1" } : {}),
    };
    cfg.models!.providers!.xai!.models = [customModel];
    if (endpointOwner === "provider") {
      cfg.models!.providers!.xai!.baseUrl = "https://custom.example.test/v1";
    }
    const result = repair(cfg);

    expect(result.config).toEqual(cfg);
    expect(result.config.agents?.defaults?.models?.["xai/auto"]?.alias).toBe("Grok");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
  },
);

it.each([false, true])(
  "respects explicit account order (%s) when declared API-key credentials are absent",
  async (hasExplicitOrder) => {
    const { cfg, state, repair } = await nativeFixture();
    await state.writeAuthProfiles({ version: 1, profiles: {} });
    if (!hasExplicitOrder) {
      delete cfg.auth!.order;
    }
    const result = repair(cfg);

    if (hasExplicitOrder) {
      expect(result.config).toEqual(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toContain("authentication route is unavailable");
    } else {
      expect(resolveDefaultModelForAgent({ cfg: result.config, agentId: "main" })).toEqual({
        provider: "xai",
        model: "grok-4.6",
      });
      expect(result.config.agents?.defaults?.model).toMatchObject({
        fallbacks: ["xai/grok-4.3"],
      });
      expect(result.config.agents?.defaults?.models?.["xai/grok-4.6"]?.alias).toBe("Grok");
      expect(result.warnings).toEqual([]);
    }
  },
);

it("keeps a missing session account pinned despite an available native xAI account", async () => {
  const { cfg, state } = await nativeFixture();
  const entry: SessionEntry = {
    sessionId: "missing-account-session",
    updatedAt: 1,
    providerOverride: "xai",
    modelOverride: "auto",
    authProfileOverride: "xai:missing",
    authProfileOverrideSource: "user",
    contextTokens: 8192,
  };
  const original = structuredClone(entry);
  const warnings: string[] = [];
  const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env, warnings });

  expect(repairRetiredSessionModelRef(entry, "main", resolve, "xai/grok-4.6", warnings)).toBe(
    false,
  );
  expect(entry).toEqual(original);
  expect(warnings).toEqual([expect.stringContaining("authentication route is unavailable")]);
});

it("repairs the native selection while preserving current and unresolved pinned choices", async () => {
  const { cfg, repair } = await nativeFixture();
  cfg.agents!.defaults!.model = {
    primary: "Grok",
    fallbacks: ["xai/auto@xai:missing", "xai/grok-4.3"],
  };
  cfg.agents!.defaults!.heartbeat = { model: "xai/grok-4.3", every: "30m" };
  cfg.agents!.entries!.main = { model: "xai/auto@xai:missing" };
  const result = repair(cfg);

  expect(resolveDefaultModelForAgent({ cfg: result.config })).toEqual({
    provider: "xai",
    model: "grok-4.6",
  });
  expect(result.config.agents?.defaults?.model).toMatchObject({
    fallbacks: ["xai/auto@xai:missing", "xai/grok-4.3"],
  });
  expect(result.config.agents?.entries?.main).toEqual(cfg.agents?.entries?.main);
  expect(result.config.agents?.defaults?.heartbeat).toEqual(cfg.agents?.defaults?.heartbeat);
  expect(result.config.models).toEqual(cfg.models);
  expect(result.warnings.join("\n")).toContain("authentication route is unavailable");
  const repeated = repair(result.config);
  expect(repeated.config).toEqual(result.config);
  expect(repeated.changes).toEqual([]);
});

it("preserves a shared alias when another physical route still accepts its old model", async () => {
  const { cfg, state } = await createRetiredModelFixture();
  cfg.agents!.defaults!.model = "retired-alias";
  cfg.agents!.defaults!.models = {
    "openai/retired-with-successor": { alias: "retired-alias", params: { temperature: 0.25 } },
  };
  cfg.agents!.defaults!.modelPolicy = { allow: ["openai/retired-with-successor"] };
  const repair = (config: OpenClawConfig) =>
    repairStaleAgentModelRefs(config, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
  const result = repair(cfg);

  expect(result.config.agents?.defaults?.model).toBe("openai/current-model");
  expect(result.config.agents?.defaults?.models).toEqual({
    "openai/retired-with-successor": { alias: "retired-alias", params: { temperature: 0.25 } },
    "openai/current-model": { params: { temperature: 0.25 } },
  });
  expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual([
    "openai/retired-with-successor",
    "openai/current-model",
  ]);
  expect(result.warnings.join("\n")).toContain("do not share a verified successor");
  const repeated = repair(result.config);
  expect(repeated.config).toEqual(result.config);
  expect(repeated.changes).toEqual([]);
});
