// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveEmbeddedRunModelSetup } from "./embedded-agent-runner/run/model-setup.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  getPreparedModelRuntimeSnapshot,
  acquireAgentRunPreparedModelRuntime,
  acquirePreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  await resetPreparedModelRuntimeHarness(state);
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("native picker acquisition failures", () => {
  async function prepareNativePickerOwner({ unconfigured = false, warmCatalog = true } = {}) {
    const { resolveAgentEffectiveModelPrimary } =
      await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    mocks.resolveAgentEffectiveModelPrimary.mockImplementation(resolveAgentEffectiveModelPrimary);
    const nativeDefault = {
      provider: "provider-a",
      id: "model",
      name: "Native default",
      nativeRuntime: "native-default",
    };
    const nativeAlternative = {
      provider: "provider-b",
      id: "model",
      name: "Native alternative",
      nativeRuntime: "native-alternative",
    };
    const loadDefault = vi.fn(async () => [nativeDefault]);
    const loadAlternative = vi.fn(async () => [nativeAlternative]);
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const registry = createEmptyPluginRegistry();
      for (const [id, loadModelCatalog] of [
        ["native-default", loadDefault],
        ["native-alternative", loadAlternative],
      ] as const) {
        registry.agentHarnesses.push({
          pluginId: id,
          source: "fixture",
          harness: {
            id,
            label: id,
            supports: () => ({ supported: true }),
            async runAttempt() {
              throw new Error("catalog-only fixture");
            },
            loadModelCatalog,
          },
        });
      }
      return registry;
    });
    const config: OpenClawConfig = unconfigured
      ? { agents: { entries: { pro: {} } } }
      : {
          agents: {
            entries: { pro: {} },
            defaults: {
              model: "provider-a/model",
              models: {
                "provider-a/model": { agentRuntime: { id: "native-default" } },
                "provider-b/model": {
                  agentRuntime: { id: "openclaw" },
                  pickerRuntimes: ["native-alternative"],
                },
              },
            },
          },
        };
    const host = { provider: "provider-b", id: "model", name: "Host alternative" };
    const providerOutcomes = [
      { provider: "provider-a", status: "ready" as const },
      { provider: "provider-b", status: "ready" as const },
    ];
    mocks.configuredAgentIds = ["pro"];
    mocks.runPreparedModelCatalogWorker.mockImplementation(async (providerIds) => ({
      entries: !providerIds || providerIds.includes(host.provider) ? [host] : [],
      routeVariants: !providerIds || providerIds.includes(host.provider) ? [host] : [],
      providerOutcomes: providerOutcomes.filter(
        ({ provider }) => !providerIds || providerIds.includes(provider),
      ),
    }));
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    const owner = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    })!;
    if (warmCatalog) {
      await owner.loadFullModelCatalog!({ refresh: true });
    }
    const freshDefault = { ...nativeDefault, name: "Fresh native default" };
    loadDefault.mockResolvedValue([freshDefault]);
    return { owner, config, loadDefault, loadAlternative, freshDefault, providerOutcomes };
  }

  it("prepares an explicit native selection from a cold run owner without picker discovery", async () => {
    const { owner, config, loadDefault, loadAlternative } = await prepareNativePickerOwner({
      unconfigured: true,
      warmCatalog: false,
    });
    expect(loadDefault).not.toHaveBeenCalled();
    expect(loadAlternative).not.toHaveBeenCalled();
    const expected = { provider: "provider-b", id: "model", nativeRuntime: "native-alternative" };
    const input = {
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
      workspaceDir: owner.workspaceDir,
      allowGatewaySubagentBinding: true,
      runtimePluginSelections: [
        {
          provider: expected.provider,
          modelId: expected.id,
          runtime: expected.nativeRuntime,
          agentId: "pro",
        },
      ],
    };
    await using lease = await acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static" });
    const workspaceDir = lease.snapshot.workspaceDir!;
    const setup = await withPluginRuntimeGenerationScope(lease.snapshot, () =>
      resolveEmbeddedRunModelSetup({
        runParams: {
          config,
          agentId: "pro",
          sessionId: "cold-native-run",
          runId: "cold-native-run",
          workspaceDir,
          prompt: "Use the saved native choice",
          timeoutMs: 30000,
          agentHarnessRuntimeOverride: expected.nativeRuntime,
        },
        provider: expected.provider,
        modelId: expected.id,
        agentDir: input.agentDir,
        workspaceDir,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: "cold-native-run", workspaceDir },
        onHooksResolved: () => {},
        preparedModelRuntime: lease.snapshot,
      }),
    );
    expect(setup.nativeModelOwned).toBe(true);
    expect(setup.agentHarness.id).toBe(expected.nativeRuntime);
    expect(setup.model).toMatchObject({ provider: expected.provider, id: expected.id });
    expect(loadAlternative).toHaveBeenCalledTimes(1);
    const discoveryCalls = [loadDefault.mock.calls.length, loadAlternative.mock.calls.length];
    await using reused = await acquireAgentRunPreparedModelRuntime(input, {
      catalogMode: "static",
    });
    expect(reused.snapshot.modelCatalog.entries).toContainEqual(expect.objectContaining(expected));
    expect(loadAlternative).toHaveBeenCalledTimes(1);
    expect([loadDefault.mock.calls.length, loadAlternative.mock.calls.length]).toEqual(
      discoveryCalls,
    );
  });

  it("publishes native providers discovered without configured runtime references", async () => {
    const { owner, freshDefault } = await prepareNativePickerOwner({ unconfigured: true });
    const catalog = await owner.loadFullModelCatalog!({ refresh: true });
    expect(catalog.entries).toContainEqual(expect.objectContaining(freshDefault));
    expect(catalog.routeVariants).toContainEqual(
      expect.objectContaining({
        provider: "provider-b",
        nativeRuntime: "native-alternative",
      }),
    );
    expect(owner.readFullModelCatalog!()).toBe(catalog);
    expect(isPreparedModelCatalogFull(catalog)).toBe(true);
  });

  it("carries the published native picker model into the actual static run lease", async () => {
    const { owner, config, loadDefault, loadAlternative } = await prepareNativePickerOwner({
      unconfigured: true,
    });
    const catalog = await owner.loadFullModelCatalog!({ refresh: true });
    const expected = { provider: "provider-a", id: "model", nativeRuntime: "native-default" };
    expect(catalog.entries).toContainEqual(expect.objectContaining(expected));
    const discoveryCalls = [loadDefault.mock.calls.length, loadAlternative.mock.calls.length];
    const input = {
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
      workspaceDir: owner.workspaceDir,
      allowGatewaySubagentBinding: true,
      runtimePluginSelections: [
        {
          provider: expected.provider,
          modelId: expected.id,
          runtime: expected.nativeRuntime,
          agentId: "pro",
        },
      ],
    };
    await using lease = await acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static" });
    const captured = lease.snapshot.modelCatalog;
    expect(captured.entries).toContainEqual(expect.objectContaining(expected));
    expect([loadDefault.mock.calls.length, loadAlternative.mock.calls.length]).toEqual(
      discoveryCalls,
    );
    const workspaceDir = lease.snapshot.workspaceDir!;
    const setup = await withPluginRuntimeGenerationScope(lease.snapshot, () =>
      resolveEmbeddedRunModelSetup({
        runParams: {
          config,
          agentId: "pro",
          sessionId: "native-picker-run",
          runId: "native-picker-run",
          workspaceDir,
          prompt: "Use the selected native model",
          timeoutMs: 30000,
          agentHarnessRuntimeOverride: expected.nativeRuntime,
        },
        provider: expected.provider,
        modelId: expected.id,
        agentDir: input.agentDir,
        workspaceDir,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: "native-picker-run", workspaceDir },
        onHooksResolved: () => {},
        preparedModelRuntime: lease.snapshot,
      }),
    );
    expect(setup.nativeModelOwned).toBe(true);
    expect(setup.model).toMatchObject({ provider: expected.provider, id: expected.id });
    await using reader = await acquirePreparedModelRuntimeSnapshot({
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    });
    expect(reader.snapshot.modelCatalog.entries).toContainEqual(expect.objectContaining(expected));
    loadDefault.mockResolvedValue([]);
    loadAlternative.mockResolvedValue([]);
    const empty = await owner.loadFullModelCatalog!({ refresh: true });
    await using next = await acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static" });
    expect(next.snapshot.modelCatalog.entries.some((entry) => entry.nativeRuntime)).toBe(false);
    expect(next.snapshot.modelCatalog.routeVariants.some((entry) => entry.nativeRuntime)).toBe(
      false,
    );
    expect(lease.snapshot.modelCatalog).toBe(captured);
    expect(captured.entries).toContainEqual(expect.objectContaining(expected));
    expect(reader.snapshot.readFullModelCatalog!()).toBe(empty);
    expect(reader.snapshot.modelCatalog.entries).toContainEqual(expect.objectContaining(expected));
  });

  it("publishes an empty completed native inventory without keeping old unconfigured rows", async () => {
    const { owner, loadDefault, loadAlternative } = await prepareNativePickerOwner({
      unconfigured: true,
    });
    expect(owner.readFullModelCatalog!()?.entries.some((entry) => entry.nativeRuntime)).toBe(true);
    loadDefault.mockResolvedValue([]);
    loadAlternative.mockResolvedValue([]);
    const empty = await owner.loadFullModelCatalog!({ refresh: true });
    expect(empty.entries.some((entry) => entry.nativeRuntime)).toBe(false);
    expect(empty.routeVariants.some((entry) => entry.nativeRuntime)).toBe(false);
    expect(empty.authoritative).not.toBe(false);
    expect(isPreparedModelCatalogFull(empty)).toBe(true);
    const calls = [loadDefault.mock.calls.length, loadAlternative.mock.calls.length];
    expect(await owner.loadFullModelCatalog!()).toBe(empty);
    expect([loadDefault.mock.calls.length, loadAlternative.mock.calls.length]).toEqual(calls);
  });

  it("publishes useful native rows and retains failed scope until its explicit recovery", async () => {
    const { owner, loadDefault, loadAlternative, freshDefault, providerOutcomes } =
      await prepareNativePickerOwner();
    loadAlternative.mockRejectedValue(new Error("Alternative catalog unavailable"));
    const partial = await owner.loadFullModelCatalog!({ refresh: true });
    expect(partial.entries).toContainEqual(expect.objectContaining(freshDefault));
    expect(partial.routeVariants).toContainEqual(expect.objectContaining(freshDefault));
    expect(
      partial.providerOutcomes?.toSorted((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    ).toEqual(providerOutcomes);
    expect(partial).toMatchObject({ authoritative: false, refreshFailed: true });
    const calls = [
      mocks.runPreparedModelCatalogWorker.mock.calls.length,
      loadDefault.mock.calls.length,
      loadAlternative.mock.calls.length,
    ];
    expect(await owner.loadFullModelCatalog!()).toBe(partial);
    expect(await owner.loadFullModelCatalog!()).toBe(partial);
    expect([
      mocks.runPreparedModelCatalogWorker.mock.calls.length,
      loadDefault.mock.calls.length,
      loadAlternative.mock.calls.length,
    ]).toEqual(calls);

    const inventoryOwner = resolvePreparedModelRuntimeOwnerBySnapshot(owner);
    for (const provider of ["provider-a", "provider-b"]) {
      const beforeRenewal = owner.readFullModelCatalog!();
      const facts = inventoryOwner?.catalogInventory?.providers.get(provider);
      if (!facts) {
        throw new Error(`Missing published inventory for ${provider}`);
      }
      const providerCalls = mocks.runPreparedModelCatalogWorker.mock.calls.length;
      facts.expiresAt = 0;
      owner.readFullModelCatalog!();
      await vi.waitFor(() => {
        expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(providerCalls + 1);
        const published = owner.readFullModelCatalog!();
        expect(published).not.toBe(beforeRenewal);
        expect(published?.pendingProviders).toBeUndefined();
      });
      const renewed = owner.readFullModelCatalog!()!;
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenLastCalledWith([provider]);
      expect(loadDefault).toHaveBeenCalledTimes(calls[1]!);
      expect(loadAlternative).toHaveBeenCalledTimes(calls[2]!);
      expect(renewed.entries).toContainEqual(expect.objectContaining(freshDefault));
      expect(
        renewed.providerOutcomes?.toSorted((left, right) =>
          left.provider.localeCompare(right.provider),
        ),
      ).toEqual(providerOutcomes);
      expect.soft(renewed, `${provider} host renewal`).toMatchObject({
        authoritative: false,
        refreshFailed: true,
      });
    }

    const unrelated = await owner.loadFullModelCatalog!({
      refresh: true,
      providerIds: ["provider-a"],
    });
    expect(unrelated).toMatchObject({ authoritative: false, refreshFailed: true });
    expect(
      unrelated.providerOutcomes?.toSorted((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    ).toEqual(providerOutcomes);
    expect(loadAlternative).toHaveBeenCalledTimes(calls[2]!);
    const recoveredAlternative = {
      provider: "provider-b",
      id: "model",
      name: "Recovered native alternative",
      nativeRuntime: "native-alternative",
    };
    loadAlternative.mockResolvedValue([recoveredAlternative]);
    const recovered = await owner.loadFullModelCatalog!({
      refresh: true,
      providerIds: ["provider-b"],
    });
    expect(recovered.routeVariants).toContainEqual(expect.objectContaining(recoveredAlternative));
    expect(recovered.entries).toContainEqual(expect.objectContaining(freshDefault));
    expect(
      recovered.providerOutcomes?.toSorted((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    ).toEqual(providerOutcomes);
    expect(recovered.authoritative).not.toBe(false);
    expect(recovered.refreshFailed).toBeUndefined();
  });

  it("rejects full native acquisition failure while retaining the published catalog", async () => {
    const { owner, loadDefault, loadAlternative } = await prepareNativePickerOwner();
    const failure = new Error("Default catalog unavailable");
    loadDefault.mockRejectedValue(failure);
    loadAlternative.mockRejectedValue(new Error("Alternative catalog unavailable"));
    await expect(owner.loadFullModelCatalog!({ refresh: true })).rejects.toBe(failure);
    expect(owner.isCurrent()).toBe(true);
    expect(owner.readFullModelCatalog!()).toMatchObject({
      authoritative: false,
      refreshFailed: true,
    });
  });

  it("does not publish partial native success after the owner is superseded", async () => {
    const { owner, config, loadAlternative, freshDefault } = await prepareNativePickerOwner();
    const started = createDeferredCore();
    const release = createDeferredCore();
    loadAlternative.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      throw new Error("Retired alternative catalog unavailable");
    });
    const refresh = owner.loadFullModelCatalog!({ refresh: true });
    const rejected = expect(refresh).rejects.toThrow("superseded");
    try {
      await started.promise;
      await refreshPreparedModelRuntimeSnapshots(
        {
          ...config,
          agents: {
            ...config.agents,
            defaults: { ...config.agents?.defaults, model: "provider-a/replacement" },
          },
        },
        { gatewayLifecycle: true, catalogMode: "static" },
      );
    } finally {
      release.resolve();
    }
    await rejected;
    expect(owner.isCurrent()).toBe(false);
    const replacement = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "pro",
      agentDir: state.agentDir("pro"),
    })!;
    expect(replacement.modelCatalog.entries).not.toContainEqual(
      expect.objectContaining(freshDefault),
    );
  });
});
