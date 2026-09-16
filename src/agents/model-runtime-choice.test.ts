import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareModelSelectionRuntime } from "../auto-reply/reply/model-runtime-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import { setPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
const request = {
  cfg,
  agentId: "main",
  provider: "fixture",
  model: "model",
  runtimeId: "openclaw",
};

function publish(
  isCurrent = () => true,
  config = cfg,
  facts: Partial<
    Pick<
      PreparedModelRuntimeSnapshot,
      "authModes" | "pluginRegistry" | "modelCatalog" | "metadataSnapshot"
    >
  > = {},
) {
  const owner = createModelRuntimeChoiceOwnerFixture(config, isCurrent, facts);
  published.owner = owner;
  return owner;
}

describe("published runtime choice", () => {
  it("keeps credential-free host selection and clears a stale cross-provider CLI pin", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          custom: { api: "openai-responses", baseUrl: "http://localhost:1234/v1", models: [] },
        },
      },
    };
    const entry = { provider: "custom", id: "custom/model", name: "Local model", reasoning: false };
    for (const agentRuntimeOverride of [undefined, "claude-cli"]) {
      const result = await prepareModelSelectionRuntime({
        cfg: config,
        agentId: "main",
        provider: "custom",
        model: "custom/model",
        catalog: [entry],
        sessionEntry: { agentRuntimeOverride },
      });
      expect(result).toMatchObject({
        status: "ready",
        runtime: { kind: agentRuntimeOverride ? "clear" : "unchanged" },
      });
    }
    expect(
      await prepareModelSelectionRuntime({
        cfg: config,
        agentId: "main",
        provider: "custom",
        model: "custom/model",
        catalog: [entry],
        rawRuntime: "openclaw",
      }),
    ).toMatchObject({ status: "rejected" });
  });

  it.each(["configured", "forced"] as const)(
    "refuses unavailable %s native selection without a catalog marker",
    async (kind) => {
      const config: OpenClawConfig =
        kind === "configured"
          ? {
              ...cfg,
              agents: {
                defaults: {
                  models: { "fixture/model": { agentRuntime: { id: "native-fixture" } } },
                },
              },
            }
          : cfg;
      if (kind === "forced") {
        vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
        vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
      }
      try {
        const result = await prepareModelSelectionRuntime({
          cfg: config,
          agentId: "main",
          provider: "fixture",
          model: "model",
          catalog: [{ provider: "fixture", id: "model", name: "Model", reasoning: false }],
          ...(kind === "forced" ? { sessionEntry: { agentRuntimeOverride: "openclaw" } } : {}),
        });
        expect(result).toMatchObject({ status: "rejected", reason: "invalid-runtime" });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("selects configured native runtime without a row marker and retains the live guard", async () => {
    let current = true;
    const config: OpenClawConfig = {
      plugins: { enabled: true },
      agents: {
        defaults: { models: { "fixture/model": { agentRuntime: { id: "native-fixture" } } } },
      },
    };
    const entry = { provider: "fixture", id: "model", name: "Model", reasoning: false };
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "native-fixture",
      source: "test",
      harness: {
        id: "native-fixture",
        label: "Native fixture",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        readModelCatalogReadiness: () => ({ accountType: "oauth", authMode: "oauth" }),
        runAttempt: vi.fn(),
      },
    });
    const owner = publish(() => current, config, {
      pluginRegistry: registry,
      modelCatalog: { entries: [entry], routeVariants: [entry] },
    });
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    const result = await prepareModelSelectionRuntime({
      cfg: config,
      agentId: "main",
      provider: "fixture",
      model: "model",
      catalog: [entry],
    });
    expect(result).toMatchObject({
      status: "ready",
      runtime: { kind: "set", runtime: "native-fixture" },
    });
    if (result.status !== "ready") {
      throw new Error("Expected native selection");
    }
    current = false;
    expect(result.validateRuntimeSelection?.()).toContain("not available");
    expect(
      await prepareModelSelectionRuntime({
        cfg: config,
        agentId: "main",
        provider: "fixture",
        model: "model",
        catalog: [entry],
        rawRuntime: "auto",
      }),
    ).toMatchObject({ status: "ready", runtime: { kind: "clear" } });
  });

  it("inherits the CLI runtime from the selected account without a session runtime pin", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "fixture-cli",
          modelProvider: "fixture",
          pluginId: "fixture-cli",
          config: { command: "fixture-cli" },
        },
      ],
    });
    const config: OpenClawConfig = {
      plugins: { enabled: true },
      auth: {
        profiles: { "fixture:cli": { provider: "fixture-cli", mode: "api_key" } },
        order: { fixture: ["fixture:cli"] },
      },
    };
    const entry = { provider: "fixture", id: "model", name: "Model", reasoning: false };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture",
          providers: ["fixture"],
          providerAuthChoices: [
            {
              provider: "fixture",
              method: "cli",
              choiceId: "fixture-cli-login",
              deprecatedChoiceIds: ["fixture-cli"],
              choiceLabel: "Fixture CLI",
            },
          ],
        },
      ],
    });
    const owner = publish(() => true, config, {
      authModes: { "fixture-cli": "api_key" },
      metadataSnapshot,
      modelCatalog: { entries: [entry], routeVariants: [entry] },
    });
    setPreparedModelRuntimeAuthStore(owner, {
      version: 1,
      profiles: {
        "fixture:cli": { type: "api_key", provider: "fixture-cli", key: "synthetic-credential" },
      },
    });
    expect(
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
        prepareModelSelectionRuntime({
          cfg: config,
          agentId: "main",
          provider: "fixture",
          model: "model",
          profileOverride: "fixture:cli",
          catalog: [entry],
        }),
      ),
    ).toMatchObject({ status: "ready", runtime: { kind: "set", runtime: "fixture-cli" } });
  });

  it("selects each native model by literal identity when display keys collide", async () => {
    const entries = [
      {
        provider: "fixture",
        id: "model",
        name: "Plain",
        reasoning: false,
        nativeRuntime: "native-plain",
      },
      {
        provider: "fixture",
        id: "fixture/model",
        name: "Prefixed",
        reasoning: false,
        nativeRuntime: "native-prefixed",
      },
    ];
    const registry = createEmptyPluginRegistry();
    for (const entry of entries) {
      registry.agentHarnesses.push({
        pluginId: entry.nativeRuntime,
        source: "test",
        harness: {
          id: entry.nativeRuntime,
          label: entry.name,
          authBootstrap: "harness",
          supports: ({ modelId }) => ({ supported: modelId === entry.id }),
          runAttempt: vi.fn(),
        },
      });
    }
    const owner = publish(() => true, cfg, {
      pluginRegistry: registry,
      modelCatalog: { entries, routeVariants: entries },
    });
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    for (const entry of entries) {
      expect(
        await prepareModelSelectionRuntime({
          cfg,
          agentId: "main",
          provider: entry.provider,
          model: entry.id,
          catalog: entries,
        }),
      ).toMatchObject({ status: "ready", runtime: { kind: "set", runtime: entry.nativeRuntime } });
    }
  });

  it("selects the published native owner without an explicit runtime and rejects stale publication", async () => {
    let current = true;
    const runtime = "native-fixture";
    const entry = { provider: "fixture", id: "model", name: "Model", nativeRuntime: runtime };
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: runtime,
      source: "test",
      harness: {
        id: runtime,
        label: "Native fixture",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
      },
    });
    const owner = publish(() => current, cfg, {
      pluginRegistry: registry,
      modelCatalog: { entries: [entry], routeVariants: [entry] },
    });
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    const choice = await preparePublishedModelRuntimeChoice({ ...request, runtimeId: undefined });
    expect(choice).toMatchObject({ kind: "ready", runtimeId: runtime });
    if (choice.kind !== "ready") {
      throw new Error("Expected native runtime selection");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });

  afterEach(() => cliBackendsTesting.resetDepsForTest());
  it.each(["model", "off-catalog"])(
    "retains compatible runtime preference through %s selection",
    async (model) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            id: "fixture-cli",
            modelProvider: "fixture",
            pluginId: "fixture-cli",
            config: { command: "fixture-cli" },
          },
        ],
      });
      const config: OpenClawConfig = {
        ...cfg,
        plugins: { enabled: true },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://models.example.invalid/v1",
              models: [],
            },
          },
        },
      };
      publish(() => true, config, { authModes: { "fixture-cli": "api_key" } });
      for (const preferredRuntimeId of ["fixture-cli", "openclaw", "missing-runtime"]) {
        const choice = await preparePublishedModelRuntimeChoice({
          ...request,
          cfg: config,
          model,
          runtimeId: undefined,
          preferredRuntimeId,
        });
        expect(choice).toMatchObject({
          kind: "ready",
          runtimeId: preferredRuntimeId === "missing-runtime" ? "openclaw" : preferredRuntimeId,
        });
        if (choice.kind !== "ready") {
          throw new Error("Expected compatible selection");
        }
        expect(choice.validate()).toBeUndefined();
      }
      expect(
        await preparePublishedModelRuntimeChoice({
          ...request,
          cfg: config,
          model,
          runtimeId: "openclaw",
          preferredRuntimeId: "fixture-cli",
        }),
      ).toMatchObject({ kind: "ready", runtimeId: "openclaw" });
    },
  );

  beforeEach(() => {
    published.owner = undefined;
  });

  it("refuses an unpublished or unresolved model", async () => {
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "unobserved" }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("validates an off-catalog model through its configured route", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    let current = true;
    publish(() => current, config);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: config,
      model: "off-catalog",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the configured off-catalog route to be selectable");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });

  it("does not grant an incompatible runtime to an off-catalog model", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    publish(() => true, config);
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        cfg: config,
        model: "off-catalog",
        runtimeId: "codex",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("rechecks the same generation at the session commit boundary", async () => {
    let current = true;
    publish(() => current);
    const choice = await preparePublishedModelRuntimeChoice(request);
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected a supported runtime");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });
});
