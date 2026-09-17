import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import { applyLegacyDoctorMigrations } from "../commands/doctor/shared/legacy-config-compat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createPluginRuntimeMock } from "../plugin-sdk/channel-test-helpers.js";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { channelReadyPatch } from "./channel-status-patches.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";

// Public artifacts share Vitest's module graph; core typechecking owns the SDK contract.
const { telegramPlugin } = await vi.importActual<{ telegramPlugin: ChannelPlugin }>(
  "../../extensions/telegram/channel-plugin-api.js",
);
const { setTelegramRuntime } = await vi.importActual<{
  setTelegramRuntime: (runtime: PluginRuntime) => void;
}>("../../extensions/telegram/runtime-setter-api.js");

describe("channel ownership startup", () => {
  let state: OpenClawTestState;
  let manager: ChannelManager;
  let registry: ReturnType<typeof createEmptyPluginRegistry>;
  let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
  const monitor =
    vi.fn<
      (options?: {
        ownerAgentId?: string;
        abortSignal?: AbortSignal;
        setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
      }) => Promise<void>
    >();

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "channel-ownership" });
    previousRegistry = getActivePluginRegistry();
    registry = createEmptyPluginRegistry();
    registry.channels.push({ pluginId: "telegram", source: "test", plugin: telegramPlugin });
    setActivePluginRegistry(registry);
    const runtime = createPluginRuntimeMock();
    const channel = {
      ...runtime.channel,
      telegram: {
        probeTelegram: async () => ({ ok: true, elapsedMs: 0 }),
        monitorTelegramProvider: monitor,
      },
    };
    setTelegramRuntime({ ...runtime, channel });
    monitor.mockImplementation(async (options) => {
      options?.setStatus?.(channelReadyPatch());
      await new Promise<void>((resolve) => {
        options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(async () => {
    await manager?.stopChannel("telegram");
    vi.useRealTimers();
    vi.restoreAllMocks();
    monitor.mockReset();
    createPluginRuntimeStore({ pluginId: "telegram", errorMessage: "unused" }).clearRuntime();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    await state.cleanup();
  });

  async function start(cfg: OpenClawConfig) {
    await state.writeConfig(cfg);
    // A restarted Gateway reads persisted config without the migration's in-memory owner.
    const runtimeConfig = JSON.parse(await readFile(state.configPath, "utf8")) as OpenClawConfig;
    const log = createSubsystemLogger("gateway/channel-ownership-test");
    manager = createChannelManager({
      getRuntimeConfig: () => runtimeConfig,
      getPluginRegistry: () => registry,
      channelLogs: { telegram: log },
      channelRuntimeEnvs: { telegram: runtimeForLogger(log) },
    });
    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("blocks an unowned Telegram account without retrying while its bound sibling stays online", async () => {
    const startAccount = vi.spyOn(telegramPlugin.gateway!, "startAccount");
    await start({
      agents: { ownership: "explicit", list: [{ id: "main" }, { id: "patricia" }] },
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "123456:synthetic-main" },
            patricia: { botToken: "789012:synthetic-patricia" },
          },
        },
      },
      bindings: [{ agentId: "patricia", match: { channel: "telegram", accountId: "patricia" } }],
    });
    const healthMonitor = startChannelHealthMonitor({ channelManager: manager });
    try {
      await vi.advanceTimersByTimeAsync(18 * 60_000);
      const accounts = manager.getRuntimeSnapshot().channelAccounts.telegram;
      expect(startAccount, JSON.stringify(accounts)).toHaveBeenCalledTimes(2);
      expect(accounts).toMatchObject({
        default: {
          running: false,
          lifecycle: "blocked",
          terminalDisconnect: true,
          restartPending: false,
          reconnectAttempts: 0,
          lastError: expect.stringContaining(
            "telegram account default routing has no explicit owner",
          ),
        },
        patricia: { running: true, connected: true, lifecycle: "ready" },
      });
      expect(accounts?.default?.lastError).toContain(
        '{"agentId":"<agentId>","match":{"channel":"telegram","accountId":"default"}}',
      );
      expect(accounts?.default?.lastError).toContain("then restart the Gateway");
      expect(manager.isAutoRestartScheduled("telegram", "default")).toBe(false);
      expect(monitor).toHaveBeenCalledTimes(1);
      expect(monitor.mock.calls[0]?.[0]?.ownerAgentId).toBe("patricia");
    } finally {
      healthMonitor.stop();
      await healthMonitor.waitForIdle();
    }
  });

  it.each([
    { authored: "ops", owner: "ops", sibling: "main" },
    { authored: "Ops", owner: "ops", sibling: "main" },
    { authored: "main", owner: "main", sibling: "patricia" },
  ])(
    "preserves legacy Telegram owner $authored across migration and a persisted restart",
    async ({ authored, owner, sibling }) => {
      const repaired = applyLegacyDoctorMigrations({
        agents: { list: [{ id: authored }, { id: sibling }] },
        channels: { telegram: { botToken: "123456:synthetic-main" } },
      });
      await start(repaired.next as OpenClawConfig);
      expect(manager.getRuntimeSnapshot().channelAccounts.telegram?.default).toMatchObject({
        running: true,
        connected: true,
        lifecycle: "ready",
        lastError: null,
      });
      expect(monitor.mock.calls[0]?.[0]?.ownerAgentId).toBe(owner);
      expect(repaired.next?.bindings).toContainEqual({
        agentId: owner,
        match: { channel: "telegram", accountId: "default" },
      });
    },
  );
});
