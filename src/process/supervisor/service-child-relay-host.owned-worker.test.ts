import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it
  .runIf(process.platform === "linux" || process.platform === "darwin")
  .each(["open", "close-before-open", "stdin-closed", "delayed-output"] as const)(
  "runs a real owned worker through its IPC start gate and output drain (%s)",
  async (action) => {
    const home = tempDirs.make("openclaw-owned-worker-gate-");
    const marker = path.join(home, "started.txt");
    const onWorkerMessage = vi.fn<(message: unknown) => void>();
    let adapter: Awaited<ReturnType<typeof createServiceChildRelayAdapter>>["adapter"] | undefined;
    let cleanup: Promise<void> | undefined;
    const expectedOutput =
      action === "delayed-output" ? "x".repeat(256 * 1024) : "owned worker finished\n";
    const rootExited = createDeferred();
    let output = "";
    let stderr = "";
    try {
      const workerArgs = [
        "-e",
        `
            const fs = require("node:fs");
            process.on("message", (message) => {
              if (JSON.stringify(message) !== '{"type":"openclaw-worker-start-v1"}') {
                process.exit(42);
              }
              fs.appendFileSync(${JSON.stringify(marker)}, "started\\n");
              process.send({ phase: "started", message }, () => {
                process.stdout.write(${action === "delayed-output" ? '"x".repeat(256 * 1024)' : JSON.stringify(expectedOutput)}, () => process.disconnect());
              });
            });
            process.send({ phase: "waiting", pid: process.pid, parentPid: process.ppid });
          `,
      ];
      const startup = await createServiceChildRelayAdapter({
        command: action === "stdin-closed" ? "/bin/sh" : process.execPath,
        // Redirect the inherited pipe before Node initializes its standard stream handles.
        args:
          action === "stdin-closed"
            ? ["-c", 'exec "$@" < /dev/null', "owned-worker-stdin", process.execPath, ...workerArgs]
            : workerArgs,
        cwd: home,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
        },
        stdinMode: "pipe-open",
        oomScoreWrapperSelected: false,
        ownedWorker: true,
        onWorkerMessage,
        onSpawnCleanup: (pending) => {
          cleanup = pending;
          void pending.catch(() => undefined);
        },
      });
      adapter = startup.adapter;
      await startup.ready;
      const collectOutput = (chunk: string) => {
        output += chunk;
      };
      if (action !== "delayed-output") {
        adapter.onStdout(collectOutput);
      }
      adapter.onExit(() => rootExited.resolve());
      adapter.onStderr((chunk) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      const ownerPid = adapter.pid;
      await vi.waitFor(() => {
        expect(onWorkerMessage).toHaveBeenCalledWith(
          expect.objectContaining({ phase: "waiting", parentPid: ownerPid }),
        );
      });
      const waiting = onWorkerMessage.mock.calls.find(
        ([message]) => isRecord(message) && message.phase === "waiting",
      )?.[0];
      expect(waiting).not.toMatchObject({ pid: adapter.pid });
      expect(existsSync(marker)).toBe(false);

      if (action !== "close-before-open") {
        if (action === "stdin-closed") {
          await vi.waitFor(async () => {
            await new Promise<void>((resolve) => {
              adapter!.stdin!.write("probe", () => resolve());
            });
            expect(adapter!.stdin!.destroyed).toBe(true);
          });
          expect(stderr).toBe("");
        }
        await Promise.all([adapter.openStartGate!(), adapter.openStartGate!()]);
        if (action === "delayed-output") {
          await withTestTimeout(
            rootExited.promise,
            5_000,
            "worker did not exit with buffered output",
          );
          // Leave the host pipe backpressured while the anchor processes root exit.
          await delay(100);
          adapter.onStdout(collectOutput);
        }
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        expect(onWorkerMessage).toHaveBeenCalledWith({
          phase: "started",
          message: { type: "openclaw-worker-start-v1" },
        });
        expect(onWorkerMessage).toHaveBeenCalledTimes(2);
        expect(await readFile(marker, "utf8")).toBe("started\n");
        expect(output.length).toBe(expectedOutput.length);
        expect(output).toBe(expectedOutput);
      } else {
        adapter.closeStartGate!();
        await expect(adapter.openStartGate!()).rejects.toThrow("closed before startup");
        await adapter.waitForExtinction();
        expect(existsSync(marker)).toBe(false);
        expect(onWorkerMessage).toHaveBeenCalledTimes(1);
        expect(output).toBe("");
      }
    } finally {
      adapter?.kill("SIGKILL");
      await adapter?.wait().catch(() => undefined);
      await cleanup?.catch((error: unknown) => {
        throw new Error(`owned worker cleanup failed: ${stderr}`, { cause: error });
      });
      adapter?.dispose();
    }
  },
  20_000,
);
