import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../process/supervisor/cancellation-policy.js";
import { createMcpStdioClient, type McpStdioClient } from "./mcp-stdio-client.js";

const fixture = vi.hoisted(() => ({
  preload: "",
  relay: undefined as ChildProcess | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof spawn>) => {
      const [command, argv, options] = args;
      if (fixture.preload && argv?.some((arg) => arg.includes("service-child-relay"))) {
        const child = actual.spawn(command, ["--import", fixture.preload, ...argv], options);
        fixture.relay = child;
        return child;
      }
      return actual.spawn(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const clients: McpStdioClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const relay = fixture.relay;
  if (relay && relay.exitCode === null && relay.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      relay.once("exit", () => resolve());
    });
    relay.kill("SIGKILL");
    await exited;
  }
  await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
  fixture.preload = "";
  fixture.relay = undefined;
});

async function createFixture() {
  const root = tempDirs.make("mcp-relay-retirement-");
  const preload = path.join(root, "retain-relay.mjs");
  await fs.writeFile(
    preload,
    // The real relay calls exit only after reaping its real anchor. Hold that last step.
    "process.exit = () => { setInterval(() => {}, 1000); };",
  );
  fixture.preload = pathToFileURL(preload).href;
  return () => {
    const client = createMcpStdioClient({
      command: process.execPath,
      args: [
        "-e",
        `require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          const result = request.method === "initialize"
            ? { protocolVersion: "2025-06-18" } : { ok: true };
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        }).on("close", () => process.exit(0));`,
      ],
      env: {},
      clientInfo: { name: "cleanup-test", version: "1" },
      protocolVersion: "2025-06-18",
      startupTimeoutMs: 10_000,
      maxPendingRequests: 4,
      maxFrameBytes: 1024,
      errors: {
        unavailable: (message, cause) => new Error(`unavailable: ${message}`, { cause }),
        protocol: (message, cause) => new Error(`protocol: ${message}`, { cause }),
      },
    });
    clients.push(client);
    return client;
  };
}

describe.skipIf(process.platform === "win32")("MCP retained relay cleanup", () => {
  it.each(["accepted", "reported failure"] as const)(
    "confirms forced relay exit and permits a fresh client after graceful cleanup stalls (%s)",
    async (signalReport) => {
      const createClient = await createFixture();
      const client = createClient();
      await expect(client.request("ping", {}, { timeoutMs: 10_000 })).resolves.toEqual({
        ok: true,
      });

      if (signalReport === "reported failure") {
        if (!fixture.relay) {
          throw new Error("expected the real relay");
        }
        const kill = fixture.relay.kill.bind(fixture.relay);
        // Report failed delivery while the native exit is still on its way to the owner.
        vi.spyOn(fixture.relay, "kill").mockImplementation((signal) => {
          kill(signal);
          return false;
        });
      }

      await client.stop();
      const result = client.cleanupResult;
      expect(result).toMatchObject({
        reason: "forced-relay-exit",
        signalRequested: "SIGKILL",
        ...(signalReport === "reported failure" ? { signalError: expect.any(Error) } : {}),
        exit: { code: null, signal: "SIGKILL" },
        durationMs: expect.any(Number),
        escalationAfterMs: expect.any(Number),
      });
      expect(result?.durationMs).toBeLessThan(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(result?.escalationAfterMs).toBeGreaterThanOrEqual(2_000);
      expect(fixture.relay?.signalCode).toBe("SIGKILL");

      fixture.preload = "";
      const next = createClient();
      await expect(next.request("ping", {}, { timeoutMs: 10_000 })).resolves.toEqual({ ok: true });
      await next.stop();
    },
  );

  it("retains timing and closure evidence when SIGKILL cannot be delivered", async () => {
    const createClient = await createFixture();
    const client = createClient();
    await client.request("ping", {}, { timeoutMs: 10_000 });
    if (!fixture.relay) {
      throw new Error("expected the real relay");
    }
    // A real process cannot ignore SIGKILL. Fault only delivery; native pipes and joins remain real.
    const kill = vi.spyOn(fixture.relay, "kill").mockReturnValue(false);
    await expect(client.stop()).rejects.toMatchObject({
      message: "unavailable: proxy cleanup could not be confirmed",
      cause: expect.objectContaining({
        message: expect.stringContaining('"relayExit":true'),
        cause: expect.objectContaining({
          durationMs: expect.any(Number),
          escalationAfterMs: expect.any(Number),
          signalError: expect.any(Error),
        }),
      }),
    });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});
