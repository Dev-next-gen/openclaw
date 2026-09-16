import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
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
    Pick<PreparedModelRuntimeSnapshot, "authModes" | "pluginRegistry" | "modelCatalog">
  > = {},
) {
  const owner = createModelRuntimeChoiceOwnerFixture(config, isCurrent, facts);
  published.owner = owner;
  return owner;
}

describe("published runtime choice", () => {
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
