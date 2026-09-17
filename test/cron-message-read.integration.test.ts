import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "../extensions/anthropic/api.js";
import { discordPlugin } from "../extensions/discord/api.js";
import { refreshPreparedModelRuntimeSnapshots } from "../src/agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import * as runtimePlugins from "../src/agents/runtime-plugins.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { loadCronStore, resolveCronJobsStorePathFromConfig } from "../src/cron/store.js";
import type { CronJobCreate } from "../src/cron/types.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../src/gateway/mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "../src/gateway/mcp-http.loopback-runtime.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { formatErrorMessage } from "../src/infra/errors.js";
import { redactToolPayloadText } from "../src/logging/redact.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../src/state/openclaw-state-db.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { createScheduledMessageReadModel } from "./helpers/scheduled-message-read-model.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

// Attached devices are outside these scheduled message journeys.
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

const channelId = "100000000000000003";
const guildId = "100000000000000001";
const messageId = "100000000000000020";
const providerMessage = "A synthetic message read by the scheduled turn.";
const modelId = "claude-sonnet-4-6";
const modelRef = `anthropic/${modelId}`;
const providerToken = "synthetic-scheduled-discord-token";
const embeddedModelId = "scheduled-message-read-fixture";
const modelToken = "synthetic-scheduled-model-token";
const scenarios = [
  { runtime: "claude-cli", action: "read" },
  { runtime: "openclaw", action: "channel-info" },
] as const;

// Uses the maintained control/JSONL child protocol from anthropic/cli-process.test.ts.
// Only the model's decisions and Discord responses are synthetic. This child reads
// the real CLI-generated MCP config and credentials; it creates no authority.
const PROTOCOL_CHILD = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const configPath = argument("--mcp-config");
if (!process.argv.includes("--mcp-config") || !configPath) {
  throw new Error("The real CLI runner did not generate an MCP config.");
}
const server = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.openclaw;
const url = new URL(server.url);
if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.pathname !== "/mcp") {
  throw new Error("Expected the task-owned loopback MCP endpoint.");
}
const headers = Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [
  name,
  value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (!process.env[key]) throw new Error("Missing generated MCP credential: " + key);
    return process.env[key];
  }),
]));
let sequence = 0;
const rpc = async (method, params) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("MCP HTTP status " + response.status);
  return await response.json();
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
  } else if (message.type === "user") {
    void (async () => {
      const sessionId = message.session_id || argument("--session-id");
      send({ type: "system", subtype: "init", session_id: sessionId, tools: [] });
      const gap = await fetch(process.env.OPENCLAW_SCHEDULED_READ_CLOCK_URL, { method: "POST" });
      if (!gap.ok) throw new Error("Could not advance the scheduled-read fixture clock.");
      const listed = await rpc("tools/list");
      const reply = await rpc("tools/call", {
        name: "message", arguments: JSON.parse(process.env.OPENCLAW_SCHEDULED_READ_ARGUMENTS),
      });
      writeFileSync(new URL("./mcp-result.json", import.meta.url), JSON.stringify({ listed, reply }));
      send({ type: "result", subtype: "success", is_error: false,
        result: JSON.stringify(reply), session_id: sessionId,
        duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
        usage: {}, modelUsage: {}, permission_denials: [],
      });
    })().catch((error) => {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
      process.stdin.destroy();
    });
  }
});
`;

type McpResponse = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: unknown;
};

function describeFixtureError(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return redactToolPayloadText(
    cause === undefined
      ? formatErrorMessage(error)
      : `${formatErrorMessage(error)}; cause: ${formatErrorMessage(cause)}`,
  );
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("operator-created scheduled message reads", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(scenarios)("$runtime/$action", { timeout: 60_000 }, async (scenario) => {
    const { runtime, action } = scenario;
    const actionParams = {
      action,
      channel: "discord",
      accountId: "default",
      ...(action === "read" ? { target: `channel:${channelId}`, limit: 1 } : { channelId }),
    };
    const expectedResult =
      action === "read"
        ? {
            ok: true,
            channelId,
            messages: [{ id: messageId, channel_id: channelId, content: providerMessage }],
          }
        : {
            ok: true,
            channel: { id: channelId, guild_id: guildId, type: 0, name: "scheduled-read" },
          };
    const assertToolResult = (text: string) => {
      expect(JSON.parse(text)).toMatchObject(expectedResult);
    };
    const embeddedModel = createScheduledMessageReadModel({
      modelId: embeddedModelId,
      apiKey: modelToken,
      actionParams,
      assertToolResult,
    });
    const isolatedHome = expectDefined(process.env.OPENCLAW_TEST_HOME, "isolated test HOME");
    const root = tempDirs.make("scheduled-message-read-", isolatedHome);
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const childPath = path.join(root, "claude.mjs");
    const cleanup: Array<() => void | Promise<void>> = [];
    const requests: Array<{ method: string; path: string; authorizationMatches: boolean }> = [];
    const providerErrors: string[] = [];
    let metadataControl: "pending" | "passed" = "pending";
    const diagnostics = (result: unknown) =>
      redactToolPayloadText(
        JSON.stringify({
          result,
          metadataControl,
          requests,
          providerErrors,
          model: embeddedModel.observation,
        }),
      );
    await runQaGatewayFixture(
      async () => {
        await mkdir(workspaceDir, { recursive: true });
        await writeFile(childPath, `#!${process.execPath}\n${PROTOCOL_CHILD}`, { mode: 0o700 });
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
        vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-config"));
        for (const key of [
          "OPENCLAW_TEST_MINIMAL_GATEWAY",
          "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
          "OPENCLAW_SKIP_CANVAS_HOST",
          "OPENCLAW_SKIP_GMAIL_WATCHER",
        ]) {
          vi.stubEnv(key, "1");
        }
        // Minimal mode suppresses channel startup; the skip flags would also
        // remove channel credentials from the published runtime config.
        vi.stubEnv("OPENCLAW_SKIP_CHANNELS", undefined);
        vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", undefined);
        vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
        const gatewayPort = await getGatewayE2ePortBlock();
        const gatewayToken = "synthetic-scheduled-read-gateway-token";
        vi.stubEnv("OPENCLAW_SCHEDULED_READ_ARGUMENTS", JSON.stringify(actionParams));
        for (const key of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
        ]) {
          vi.stubEnv(key, undefined);
        }
        cleanup.push(() => clearRuntimeConfigSnapshot());
        cleanup.push(() => closeOpenClawStateDatabaseForTest());
        cleanup.push(() => closeOpenClawStateDatabaseAsync());

        const provider = createServer((req, res) => {
          void (async () => {
            const url = new URL(req.url ?? "/", "http://fixture.invalid");
            if (req.method === "POST" && url.pathname === "/scheduled-clock-gap") {
              expect(runtime).toBe("claude-cli");
              expect(metadataControl).toBe("passed");
              const realNow = Date.now.bind(Date);
              // The real CLI has its grant; model a pause beyond its former timeout-plus-grace TTL.
              vi.spyOn(Date, "now").mockImplementation(() => realNow() + 120_000);
              res.writeHead(200).end();
              return;
            }
            if (req.method === "POST" && url.pathname === "/v1/responses") {
              expect(runtime, "embedded model request uses the selected runtime").toBe("openclaw");
              await embeddedModel.respond(req, res);
              return;
            }
            const authorizationMatches = req.headers.authorization === `Bot ${providerToken}`;
            requests.push({ method: req.method ?? "", path: url.pathname, authorizationMatches });
            expect(authorizationMatches, "Discord fixture authorization matches").toBe(true);
            expect(req.method).toBe("GET");
            const body =
              url.pathname === `/api/v10/channels/${channelId}`
                ? { id: channelId, type: 0, guild_id: guildId, name: "scheduled-read" }
                : url.pathname === `/api/v10/channels/${channelId}/messages`
                  ? [
                      {
                        id: messageId,
                        channel_id: channelId,
                        content: providerMessage,
                        author: {
                          id: "100000000000000009",
                          username: "synthetic",
                          discriminator: "0",
                        },
                        timestamp: "2026-09-16T09:00:00.000Z",
                        type: 0,
                        attachments: [],
                        embeds: [],
                      },
                    ]
                  : undefined;
            if (body === undefined) {
              throw new Error(`Unexpected provider request: ${req.method} ${url.pathname}`);
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
          })().catch((error: unknown) => {
            providerErrors.push(describeFixtureError(error));
            res.writeHead(500).end();
          });
        });
        cleanup.push(() => closeServer(provider));
        await new Promise<void>((resolve, reject) => {
          provider.once("error", reject);
          provider.listen(0, "127.0.0.1", resolve);
        });
        const address = provider.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected provider TCP address");
        }
        const providerOrigin = `http://127.0.0.1:${address.port}`;
        vi.stubEnv("OPENCLAW_SCHEDULED_READ_CLOCK_URL", `${providerOrigin}/scheduled-clock-gap`);
        const embedded = buildMockOpenAiResponsesProvider(`${providerOrigin}/v1`, embeddedModelId);
        const selectedModelRef = runtime === "openclaw" ? embedded.modelRef : modelRef;
        const cfg: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: gatewayPort,
            auth: { mode: "token", token: gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            ownership: "explicit",
            entries: { main: {} },
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              timeoutSeconds: 40,
              model: { primary: selectedModelRef, fallbacks: [] },
              models: {
                [modelRef]: { agentRuntime: { id: "claude-cli" } },
                [embedded.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              thinkingDefault: "off",
            },
          },
          models: {
            providers: {
              [embedded.providerId]: {
                ...embedded.config,
                apiKey: modelToken,
                request: { allowPrivateNetwork: true },
              },
              anthropic: {
                api: "anthropic-messages",
                baseUrl: "https://api.anthropic.com",
                apiKey: "synthetic-unused-model-key",
                models: [
                  {
                    id: modelId,
                    name: "Synthetic Claude CLI model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          tools: { allow: ["message"] },
          plugins: { allow: ["anthropic", "discord"], slots: { memory: "none" } },
          channels: {
            discord: {
              enabled: true,
              token: providerToken,
              groupPolicy: "allowlist",
              guilds: { [guildId]: { channels: { "*": { enabled: true } } } },
            },
          },
          cron: { enabled: false },
        };
        await writeFile(configPath, JSON.stringify(cfg));
        setRuntimeConfigSnapshot(cfg, cfg);

        vi.stubEnv("DISCORD_API_URL", `${providerOrigin}/api/v10`);
        await ensureMcpLoopbackServer(0);
        cleanup.push(() => closeMcpLoopbackServer());
        const mcpRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "task-owned MCP runtime");
        const mcpOrigin = `http://127.0.0.1:${mcpRuntime.port}`;
        const realFetch = globalThis.fetch.bind(globalThis);
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (
              url.origin !== providerOrigin &&
              url.origin !== mcpOrigin &&
              url.origin !== `http://127.0.0.1:${gatewayPort}`
            ) {
              throw new Error(`Unexpected fixture network destination: ${url.origin}`);
            }
            return await realFetch(input, init);
          }),
        );

        const owner = createPluginRegistry({
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          runtime: {} as PluginRuntime,
          activateGlobalSideEffects: false,
        });
        for (const id of ["anthropic", "discord"]) {
          const record = createPluginRecord({ id, origin: "global", trustedOfficialInstall: true });
          owner.registry.plugins.push(record);
          const api = owner.createApi(record, { config: cfg, registrationMode: "full" });
          if (id === "discord") {
            api.registerChannel({ plugin: { ...discordPlugin, status: undefined } });
          } else {
            const backend = buildAnthropicCliBackend();
            api.registerCliBackend({
              ...backend,
              config: { ...backend.config, command: childPath },
            });
          }
        }
        setActivePluginRegistry(owner.registry);
        cleanup.push(() => resetPluginRuntimeStateForTest());
        // Installed discovery is outside this fixture. Both maintained acquisition
        // paths borrow the same real registrations while prepared-runtime ownership stays real.
        vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockImplementation(
          (_params, onPrimaryRegistry) => {
            onPrimaryRegistry?.(owner.registry);
            return owner.registry;
          },
        );
        vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry").mockResolvedValue({
          registry: owner.registry,
          primaryRegistry: owner.registry,
        });
        cleanup.push(() => resetPreparedModelRuntimeSnapshotsForTest());
        const finished = createDeferred<Record<string, unknown>>();
        const scheduledJob: { id?: string } = {};
        const gateway = await startGatewayWithClient({
          port: gatewayPort,
          cfg,
          configPath,
          token: gatewayToken,
          scopes: ["operator.admin"],
          onEvent: (event) => {
            if (
              event.event === "cron" &&
              isRecord(event.payload) &&
              event.payload.action === "finished" &&
              event.payload.jobId === scheduledJob.id
            ) {
              finished.resolve(event.payload);
            }
          },
        });
        cleanup.push(async () => {
          await runQaGatewayFixture(
            () => disconnectGatewayClient(gateway.client),
            () => gateway.server.close({ reason: "scheduled read fixture complete" }),
          );
        });
        await gateway.server.startupSettled;
        await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        const runtimeConfig = getRuntimeConfig();
        const { fetchChannelInfoDiscord } = await import("../extensions/discord/runtime-api.js");
        const metadata = await fetchChannelInfoDiscord(channelId, {
          cfg: runtimeConfig,
          accountId: "default",
        }).catch((error: unknown) => {
          throw new Error(diagnostics({ metadataError: describeFixtureError(error) }));
        });
        expect(metadata, diagnostics(metadata)).toMatchObject({
          id: channelId,
          type: 0,
          guild_id: guildId,
        });
        expect(requests, diagnostics(metadata)).toEqual([
          {
            method: "GET",
            path: `/api/v10/channels/${channelId}`,
            authorizationMatches: true,
          },
        ]);
        metadataControl = "passed";
        // The direct transport control cannot satisfy the scheduled journey's evidence.
        requests.length = 0;
        const params = {
          name: `Scheduled Discord ${action}`,
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: `Use message action ${action} for Discord channel ${channelId} with account default.`,
            toolsAllow: ["message"],
          },
          delivery: { mode: "none" },
        } satisfies CronJobCreate;
        const created = await gateway.client.request<{ id: string }>("cron.add", params);
        scheduledJob.id = created.id;
        const storePath = resolveCronJobsStorePathFromConfig(getRuntimeConfig());
        const job = expectDefined(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === created.id),
          "persisted scheduled job",
        );
        expect(job.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
        expect(
          await gateway.client.request("cron.run", { id: job.id, mode: "force" }),
        ).toMatchObject({ ok: true, enqueued: true });
        const completion = await withTestTimeout(
          finished.promise,
          45_000,
          "Expected scheduled agent completion",
        );
        expect(completion, diagnostics(completion)).toMatchObject({ status: "ok" });
        let text: string | undefined;
        if (runtime === "claude-cli") {
          const observation = JSON.parse(
            await readFile(path.join(root, "mcp-result.json"), "utf8"),
          ) as {
            listed: McpResponse;
            reply: McpResponse;
          };
          expect(observation.listed.result?.tools).toContainEqual(
            expect.objectContaining({ name: "message" }),
          );
          expect(observation.reply.error, diagnostics(observation.reply)).toBeUndefined();
          expect(observation.reply.result?.isError, diagnostics(observation.reply)).toBe(false);
          text = observation.reply.result?.content?.find((item) => item.type === "text")?.text;
        } else {
          expect(embeddedModel.observation, diagnostics(completion)).toMatchObject({
            requests: 2,
            messageToolAdvertised: true,
          });
          text = embeddedModel.observation.toolOutput;
        }
        assertToolResult(expectDefined(text, "scheduled provider tool result"));
        expect(requests).toContainEqual({
          method: "GET",
          path: `/api/v10/channels/${channelId}`,
          authorizationMatches: true,
        });
        if (action === "read") {
          expect(requests).toContainEqual({
            method: "GET",
            path: `/api/v10/channels/${channelId}/messages`,
            authorizationMatches: true,
          });
        }
        expect(providerErrors).toEqual([]);
      },
      () => runQaGatewayFixture(async () => {}, ...cleanup.toReversed()),
      () => vi.restoreAllMocks(),
      () => vi.unstubAllGlobals(),
      () => vi.unstubAllEnvs(),
    );
  });
});
