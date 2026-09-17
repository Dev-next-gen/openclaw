import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureApprovedCwdSnapshotSync,
  ApprovedCwdDriftError,
} from "../infra/system-run-cwd-binding.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { testing } from "./invoke.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

function mockNextSpawn(child: MockChild): void {
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
}

describe("runCommand", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects directory replacement at the final spawn boundary", async () => {
    await withTempDir("node-exec-cwd-", async (root) => {
      const canonicalRoot = await fs.realpath(root);
      const cwd = path.join(canonicalRoot, "work");
      await fs.mkdir(cwd);
      const captured = captureApprovedCwdSnapshotSync(cwd);
      if (!captured.ok) {
        throw new Error(captured.message);
      }
      await fs.rename(cwd, path.join(canonicalRoot, "original"));
      await fs.mkdir(cwd);
      await expect(
        testing.runCommand(["echo", "never"], cwd, undefined, undefined, captured.snapshot),
      ).rejects.toBeInstanceOf(ApprovedCwdDriftError);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it.each(["stdout", "stderr"] as const)(
    "settles after child exit when %s emits an error",
    async (streamName) => {
      const child = createMockChild();
      mockNextSpawn(child);

      const resultPromise = testing.runCommand(["echo", "hello"], undefined, undefined, undefined);
      child.stdout.emit("data", Buffer.from("captured stdout"));
      child.stderr.emit("data", Buffer.from("captured stderr"));
      child[streamName].emit("error", new Error(`${streamName} broke`));

      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.stdout.emit("error", new Error("later stdout error"));
      child.stderr.emit("error", new Error("later stderr error"));
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit("exit", 1);

      await expect(resultPromise).resolves.toEqual({
        exitCode: 1,
        timedOut: false,
        success: false,
        stdout: "captured stdout",
        stderr: "captured stderr",
        error: `${streamName} broke`,
        truncated: false,
      });
    },
  );

  it("escalates stream-error termination when the child does not exit", async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    mockNextSpawn(child);

    const resultPromise = testing.runCommand(["slow"], undefined, undefined, undefined);
    child.stderr.emit("error", new Error("stderr broke"));

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(testing.STREAM_ERROR_KILL_GRACE_MS);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    child.emit("exit", null);
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: undefined,
      timedOut: false,
      success: false,
      error: "stderr broke",
    });
  });

  it("preserves child spawn errors", async () => {
    const child = createMockChild();
    mockNextSpawn(child);

    const resultPromise = testing.runCommand(["missing"], undefined, undefined, undefined);
    child.emit("error", new Error("spawn failed"));

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: undefined,
      timedOut: false,
      success: false,
      error: "spawn failed",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("preserves timeout termination and exit settlement", async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    mockNextSpawn(child);

    const resultPromise = testing.runCommand(["slow"], undefined, undefined, 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", null);
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: undefined,
      timedOut: true,
      success: false,
      error: null,
    });
  });
});
