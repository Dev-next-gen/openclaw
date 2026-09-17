import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  runManagedCommand,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnWindowsJobChild: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../../scripts/lib/managed-windows-job.mts", () => ({
  spawnWindowsJobChild: mocks.spawnWindowsJobChild,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("does not certify an unavailable POSIX group observation when its wait expires", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("group observation unavailable"), { code: "EIO" });
  });
  await expect(
    waitForManagedProcessGroupExit({ pid: 12345 }, 0, {
      platform: "darwin",
      errorPolicy: "indeterminate",
    }),
  ).resolves.toBe(false);
});

it.each(["returned false", "ESRCH"])(
  "does not promote POSIX leader disappearance (%s) after denied group signaling",
  (result) => {
    const child = {
      pid: 12345,
      kill: vi.fn(() => {
        if (result === "ESRCH") {
          throw Object.assign(new Error("leader is gone"), { code: "ESRCH" });
        }
        return false;
      }),
    };
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("group signal denied"), { code: "EPERM" });
    });
    expect(terminateManagedChild(child, "SIGTERM", { platform: "darwin" })).toEqual({
      processTreeState: "indeterminate",
    });
  },
);

it.each([
  [255, "live"],
  [255, "unavailable"],
  [0, "live"],
] as const)(
  "retains a Windows Job after taskkill status %i until independent-output descendants exit (%s observation)",
  async (status, state) => {
    const root = dirs.make("managed-job-retention-");
    const owner = createVitestResourceOwner(root);
    const child = new ChildProcess();
    let exitCode: number | null = null;
    Object.defineProperties(child, {
      pid: { value: 12345 },
      exitCode: { get: () => exitCode },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const descendantOutput = new PassThrough();
    const closed = Promise.all([once(child.stdout, "close"), once(child.stderr, "close")]);
    const observed = createDeferred();
    const job = {
      inspect: vi.fn(() => {
        observed.resolve();
        if (state === "unavailable") {
          throw new Error("Job observation unavailable");
        }
        return [23456];
      }),
      beginStop: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
    };
    mocks.spawn.mockReturnValue(child);
    mocks.spawnWindowsJobChild.mockReturnValue({ child, job });
    vi.spyOn(child, "kill").mockReturnValue(true);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const abort = new AbortController();
    const taskkill = vi.fn(() => {
      exitCode = 0;
      child.emit("exit", 0, null);
      child.stdout?.destroy();
      child.stderr?.destroy();
      return { status, stdout: "leader exited", stderr: status ? "taskkill failed" : "" };
    });
    const completed = runManagedCommand({
      bin: "fixture",
      platform: "win32",
      shell: false,
      stdio: "pipe",
      env: { TMPDIR: root },
      signal: abort.signal,
      runTaskkill: taskkill,
      onReady: () => abort.abort(),
    });
    const outcome = completed.catch((error: unknown) => error);
    try {
      await closed;
      await Promise.race([observed.promise, outcome]);
      expect(descendantOutput.destroyed).toBe(false);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          processTreeState: "indeterminate",
          survivingPids: state === "live" ? [23456] : undefined,
        }),
      );
      expect(job.close).not.toHaveBeenCalled();
      expect(job.stop).toHaveBeenCalledOnce();
    } finally {
      // This is the independent descendant's completion fact, not elapsed time or leader EOF.
      descendantOutput.destroy();
      job.inspect.mockReturnValue([]);
      await outcome;
    }
    expect(await outcome).toMatchObject({ code: "ABORT_ERR" });
    owner.assertReleased();
    expect(job.close).toHaveBeenCalledOnce();
  },
);
