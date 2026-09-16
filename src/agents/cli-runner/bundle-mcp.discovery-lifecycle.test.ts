import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { retireSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { buildCodexUserMcpServersThreadConfigPatchForRun } from "./bundle-mcp-codex.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("native MCP discovery ownership", () => {
  it.each(["app-server", "cli"] as const)(
    "%s releases discovery children and never starts policy-denied servers",
    async (adapter) => {
      const workspaceDir = tempDirs.make("openclaw-mcp-discovery-");
      const pidPath = path.join(workspaceDir, "children.jsonl");
      const serverPath = path.join(workspaceDir, "server.mjs");
      await fs.writeFile(pidPath, "");
      await fs.writeFile(
        serverPath,
        `import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
const relay = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
appendFileSync(process.argv[2], JSON.stringify([process.pid, process.ppid, relay]) + "\\n");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "discovery", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [{ name: "read_note", description: "Synthetic note", inputSchema: { type: "object", properties: {} } }] });
});
`,
      );
      const children = async (): Promise<number[][]> =>
        (await fs.readFile(pidPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as number[]);
      const sessions: string[] = [];
      const authStorage = AuthStorage.inMemory();
      await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
        try {
          for (const denied of [false, false, false, true]) {
            const sessionId = `${adapter}-discovery-${sessions.length}`;
            sessions.push(sessionId);
            const sessionKey = `agent:main:${sessionId}`;
            const server = { command: process.execPath, args: [serverPath, pidPath] };
            const config: OpenClawConfig = {
              plugins: { enabled: false },
              agents: { entries: { main: { tools: denied ? { deny: ["bundle-mcp"] } : {} } } },
              mcp: { servers: { alpha: server, beta: server } },
            };
            if (adapter === "app-server") {
              const patch = await buildCodexUserMcpServersThreadConfigPatchForRun({
                cwd: workspaceDir,
                run: {
                  agentId: "main",
                  sessionId,
                  sessionKey,
                  sessionFile: sessionKey,
                  workspaceDir,
                  config,
                  prompt: "hello",
                  timeoutMs: 5_000,
                  runId: sessionId,
                  provider: "openai",
                  modelId: "gpt-5.6-luna",
                  model: {
                    id: "gpt-5.6-luna",
                    name: "Test model",
                    api: "openai-responses",
                    provider: "openai",
                    baseUrl: "http://127.0.0.1:1",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 100_000,
                    maxTokens: 1_000,
                  },
                  authStorage,
                  authProfileStore: { version: 1, profiles: {} },
                  modelRegistry: ModelRegistry.inMemory(authStorage),
                  thinkLevel: "off",
                },
              });
              expect(Object.keys(patch?.mcp_servers ?? {})).toEqual(
                denied ? [] : ["alpha", "beta"],
              );
            } else {
              const prepared = await prepareCliBundleMcpConfig({
                enabled: true,
                mode: "codex-config-overrides",
                backend: { command: "codex", args: ["exec"] },
                workspaceDir,
                config,
                nativeMcpPolicy: {
                  sessionId,
                  sessionKey,
                  capabilityProfile: resolveConversationCapabilityProfile({
                    config,
                    agentId: "main",
                    sessionId,
                    sessionKey,
                    workspaceDir,
                  }),
                },
              });
              try {
                const projected = prepared.backend.args?.find((arg) =>
                  arg.startsWith("mcp_servers="),
                );
                expect(projected?.includes("read_note") ?? false).toBe(!denied);
              } finally {
                await prepared.cleanup?.();
              }
            }
          }
          const spawned = await children();
          // Each allowed discovery starts two servers; the denied agent starts none.
          expect.soft(spawned).toHaveLength(6);
          expect(spawned.flat().filter(isPidAlive)).toEqual([]);
        } finally {
          for (const sessionId of sessions) {
            await retireSessionMcpRuntime({ sessionId, reason: "discovery-test-cleanup" });
          }
        }
      });
    },
  );
});
