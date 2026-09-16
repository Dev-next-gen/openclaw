/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { beginModelCatalogRead, publishModelCatalogResult } from "../../lib/model-catalog-cache.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createFirstRunContext,
  detection,
  mountPage,
} from "./model-setup-first-run.test-support.ts";

function nativeCatalog(available = true): ModelCatalogResult {
  return {
    models: [
      {
        provider: "acp-opencode",
        id: "fixture-model",
        name: "Fixture model",
        available,
        apiKeySupported: false,
        agentRuntime: { id: "acp-opencode", source: "model" },
        ...(available ? {} : { unavailableReason: "missing-auth" as const }),
      },
    ],
  };
}

async function fixture(
  catalog: ModelCatalogResult = nativeCatalog(),
  beforeRefresh?: () => Promise<void>,
) {
  const base = createFirstRunContext(undefined, beforeRefresh);
  const agents = createAgentCapability(base.context.gateway);
  Object.assign(base.context, { agents });
  const listeners = new Set<GatewayEventListener>();
  vi.spyOn(base.context.gateway, "subscribeEvents").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  base.request.mockImplementation(async (method) => {
    if (method === "models.list") {
      return catalog;
    }
    if (method === "agents.update") {
      return { ok: true, agentId: "main" };
    }
    if (method === "agents.list") {
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", model: "acp-opencode/fixture-model" }],
      };
    }
    if (method === "openclaw.setup.detect") {
      return detection;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const mounted = await mountPage(base.context, {
    client: base.client,
    firstRun: true,
    state: { phase: "ready", result: detection },
  });
  const trigger = mounted.page.querySelector<HTMLButtonElement>(
    "[data-native-model-setup] .picker-select__trigger",
  );
  expect(trigger).not.toBeNull();
  trigger!.click();
  return { ...base, ...mounted, agents, listeners };
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Model Setup native Use", () => {
  it("does not refresh or navigate after a pending Use loses its mounted page", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const { page, context, agents } = await fixture(nativeCatalog(), async () => {
      entered.resolve();
      await release.promise;
    });
    const refresh = vi.spyOn(agents, "refreshList");
    await waitForFast(() => expect(page.querySelector('[role="option"]')).not.toBeNull());
    page.querySelector<HTMLElement>('[role="option"]')!.click();
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>("[data-native-model-setup] button.primary")!.click();
    await entered.promise;
    const mutation = vi.mocked(context.runtimeConfig.runExternalMutation).mock.results[0]!;
    page.remove();
    release.resolve();
    await mutation.value;
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
    agents.dispose();
  });
  it("selects through the shared picker and writes the exact tuple without verification", async () => {
    const { page, request, context, agents } = await fixture();
    await waitForFast(() =>
      expect(
        page.querySelector('[role="option"][data-value="acp-opencode/fixture-model"]'),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLElement>('[role="option"][data-value="acp-opencode/fixture-model"]')!
      .click();
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>("[data-native-model-setup] button.primary")!.click();
    await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("chat"));
    expect(request).toHaveBeenCalledWith("agents.update", {
      agentId: "main",
      model: "acp-opencode/fixture-model",
      agentRuntime: "acp-opencode",
    });
    expect(
      request.mock.calls.some(
        ([method]) =>
          method === "openclaw.setup.verify" || method === "openclaw.setup.activate.start",
      ),
    ).toBe(false);
    expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    expect(agents.state.agentsList?.agents[0]?.model).toBe("acp-opencode/fixture-model");
    agents.dispose();
  });

  it("does not select a discovered model that requires native sign-in", async () => {
    const { page, request, agents } = await fixture(nativeCatalog(false));
    await waitForFast(() =>
      expect(page.textContent).toContain("Sign in through the installed agent"),
    );
    expect(page.querySelector('[role="option"]')?.getAttribute("aria-disabled")).toBe("true");
    expect(
      page.querySelector<HTMLButtonElement>("[data-native-model-setup] button.primary")?.disabled,
    ).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "agents.update")).toBe(false);
    agents.dispose();
  });

  it("updates an open picker when the shared catalog finishes cold discovery", async () => {
    const { page, request, client, listeners, agents } = await fixture({
      models: [],
      pendingProviders: ["acp-opencode"],
    });
    await waitForFast(() => expect(page.textContent).toContain("Checking installed agents"));
    const scope = { view: "all" as const, agentId: "main" };
    const ready = nativeCatalog();
    publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, ready);
    for (const listener of listeners) {
      listener({ type: "event", event: "models.snapshot", payload: { scope, catalog: ready } });
    }
    await waitForFast(() =>
      expect(
        page.querySelector('[role="option"][data-value="acp-opencode/fixture-model"]'),
      ).not.toBeNull(),
    );
    expect(page.textContent).not.toContain("Checking installed agents");
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" && Reflect.get(params ?? {}, "refresh") === true,
      ),
    ).toHaveLength(1);
    agents.dispose();
  });

  it("shows catalog failure without leaving a loading status", async () => {
    const { page, agents } = await fixture({ models: [], refreshFailed: true });
    await waitForFast(() =>
      expect(page.querySelector('[data-native-model-setup] [role="alert"]')).not.toBeNull(),
    );
    expect(page.textContent).not.toContain("Checking installed agents");
    expect(page.textContent).not.toContain("No models are available from installed agents.");
    agents.dispose();
  });
});
