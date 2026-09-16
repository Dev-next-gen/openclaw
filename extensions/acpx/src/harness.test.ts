import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { createAcpAgentHarness } from "./harness.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

const handle = {
  sessionKey: "stored-resource",
  backend: "acpx",
  runtimeSessionName: "stored-handle",
  backendSessionId: "adapter-session",
};
const catalog = {
  config: {},
  agentId: "main",
  agentDir: "/test/agent",
  workspaceDir: "/test/work",
};
const session = { agentId: "main", sessionId: "conversation", sessionKey: "agent:main:chat" };

function fixture() {
  const runtime = {
    inspectAgent: vi.fn<CompleteAcpRuntime["inspectAgent"]>(async () => ({
      id: "opencode",
      name: "OpenCode",
      launch: { kind: "installed", argv: ["/test/bin/opencode", "acp"] },
    })),
    ensureSession: vi.fn(async () => handle),
    findSession: vi.fn<CompleteAcpRuntime["findSession"]>(async () => handle),
    getStatus: vi.fn<CompleteAcpRuntime["getStatus"]>(async () => ({
      models: {
        availableModelIds: ["vendor/model"],
        availableModels: [{ modelId: "vendor/model", name: "Vendor Model" }],
      },
    })),
    startTurn() {
      throw new Error("Catalog and retirement must not submit prompts");
    },
    async *runTurn() {},
    getCapabilities: async () => ({ controls: [] }),
    setMode: async () => {},
    setModel: async () => {},
    setConfigOption: async () => {},
    doctor: async () => ({ ok: true, message: "ready" }),
    prepareFreshSession: vi.fn(async () => {}),
    cancel: async () => {},
    close: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  } satisfies CompleteAcpRuntime;
  const getRuntime = vi.fn(async () => runtime);
  const harness = createAcpAgentHarness({
    agent: "opencode",
    label: "OpenCode",
    api: createTestPluginApi({ runtime: createPluginRuntimeMock() }),
    getRuntime,
    shutdown: runtime.shutdown,
  });
  if (
    !harness.loadModelCatalog ||
    !harness.reset ||
    !harness.withSessionDeletion ||
    !harness.dispose
  ) {
    throw new Error("Native harness must expose catalog and session lifecycle operations");
  }
  return {
    runtime,
    getRuntime,
    harness,
    loadCatalog: harness.loadModelCatalog.bind(harness),
    reset: harness.reset.bind(harness),
    remove: harness.withSessionDeletion.bind(undefined),
    dispose: harness.dispose.bind(harness),
  };
}

it("publishes native model IDs and labels without interpreting their contents", async () => {
  const f = fixture();
  f.runtime.getStatus.mockResolvedValue({
    models: {
      availableModelIds: ["plain-model", "vendor/nested/model"],
      availableModels: [
        { modelId: "plain-model", name: "Plain Model" },
        { modelId: "vendor/nested/model", name: "Nested Model" },
      ],
    },
  });
  expect(await f.loadCatalog(catalog)).toEqual([
    {
      provider: "acp-opencode",
      id: "plain-model",
      name: "Plain Model",
      nativeRuntime: "acp-opencode",
    },
    {
      provider: "acp-opencode",
      id: "vendor/nested/model",
      name: "Nested Model",
      nativeRuntime: "acp-opencode",
    },
  ]);
});

it.each([undefined, "present", "none"] as const)(
  "requires verified endpoint compatibility (%s)",
  (endpointOverrides) => {
    const { harness } = fixture();
    expect(
      harness.supports({
        provider: "vendor",
        requestedRuntime: "acp-opencode",
        modelProvider: { endpointOverrides, preparedAuth: { source: "harness" } },
      }).supported,
    ).toBe(endpointOverrides === "none");
  },
);

it("refreshes missing installations into native model rows and closes only the catalog session", async () => {
  const f = fixture();
  f.runtime.inspectAgent.mockResolvedValueOnce({
    id: "opencode",
    name: "OpenCode",
    launch: { kind: "missing", requirements: [{ kind: "command", name: "opencode" }] },
  });
  expect(await f.loadCatalog(catalog)).toEqual([]);
  expect(f.runtime.ensureSession).not.toHaveBeenCalled();
  expect(await f.loadCatalog(catalog)).toEqual([
    {
      provider: "acp-opencode",
      id: "vendor/model",
      name: "Vendor Model",
      nativeRuntime: "acp-opencode",
    },
  ]);
  expect(f.runtime.ensureSession).toHaveBeenCalledWith(
    expect.objectContaining({
      agentCommand: ["/test/bin/opencode", "acp"],
      mode: "oneshot",
      bridgeSession: null,
    }),
  );
  expect(f.runtime.close).toHaveBeenCalledExactlyOnceWith({
    handle,
    reason: "catalog-complete",
  });
  await f.dispose();
  expect(f.runtime.shutdown).toHaveBeenCalledOnce();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

it("closes catalog handles when model inspection fails", async () => {
  const f = fixture();
  vi.mocked(f.runtime.getStatus).mockRejectedValue(new Error("adapter disconnected"));
  await expect(f.loadCatalog(catalog)).rejects.toThrow("adapter disconnected");
  expect(f.runtime.close).toHaveBeenCalledExactlyOnceWith({
    handle,
    reason: "catalog-complete",
  });
});

it("resolves reset and committed deletion from stored handles after restart", async () => {
  const f = fixture();
  vi.mocked(f.runtime.findSession).mockResolvedValueOnce(undefined);
  await f.reset(session);
  expect(f.runtime.prepareFreshSession).not.toHaveBeenCalled();
  await f.reset(session);
  expect(f.runtime.findSession).toHaveBeenLastCalledWith({
    sessionKey: "agent:main:harness:acp-opencode:conversation",
    agent: "opencode",
    agentId: "main",
  });
  expect(f.runtime.prepareFreshSession).toHaveBeenCalledExactlyOnceWith({
    handle: {
      ...handle,
      bridgeSession: { agentId: "main", sessionKey: session.sessionKey, native: true },
    },
  });
  const input = { ...session, assertCurrent: vi.fn() };
  await f.remove(input, async (mutation) => {
    mutation.commit();
    mutation.rollback();
  });
  expect(f.runtime.prepareFreshSession).toHaveBeenCalledTimes(1);
  await f.remove(input, async (mutation) => {
    mutation.commit();
  });
  expect(f.runtime.prepareFreshSession).toHaveBeenCalledTimes(2);
  expect(f.runtime.close).not.toHaveBeenCalled();
  expect(f.runtime.ensureSession).not.toHaveBeenCalled();
});

it("propagates local retirement failures without starting a replacement session", async () => {
  const f = fixture();
  f.runtime.prepareFreshSession.mockRejectedValue(new Error("Local reset could not be saved"));
  await expect(f.reset(session)).rejects.toThrow("Local reset could not be saved");
  await expect(
    f.remove({ ...session, assertCurrent: vi.fn() }, async (mutation) => mutation.commit()),
  ).rejects.toThrow("Local reset could not be saved");
  expect(f.runtime.ensureSession).not.toHaveBeenCalled();
  expect(f.runtime.prepareFreshSession).toHaveBeenCalledTimes(2);
  expect(f.runtime.close).not.toHaveBeenCalled();
});

it("does not retire a stored handle when deletion authority expires during lookup", async () => {
  const f = fixture();
  const lookup = createDeferred<typeof handle | undefined>();
  const entered = createDeferred<void>();
  vi.mocked(f.runtime.findSession).mockImplementation(async () => {
    entered.resolve();
    return lookup.promise;
  });
  let current = true;
  const deletion = f.remove(
    {
      ...session,
      assertCurrent() {
        if (!current) {
          throw new Error("session replaced");
        }
      },
    },
    async (mutation) => {
      mutation.commit();
    },
  );
  await entered.promise;
  current = false;
  lookup.resolve(handle);
  await expect(deletion).rejects.toThrow("session replaced");
  expect(f.runtime.prepareFreshSession).not.toHaveBeenCalled();
});
