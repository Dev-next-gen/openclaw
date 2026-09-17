import { Duplex, PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createStubChild, firstMockArg } from "./adapters/child.test-support.js";
import { encodeServiceChildMessage } from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

it.skipIf(process.platform === "win32").each([false, true])(
  "joins a failed authority close without an unhandled rejection (root observed=%s)",
  async (rootObserved) => {
    const stub = createStubChild();
    const control = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const lineage = new PassThrough();
    Object.defineProperty(stub.child, "stdio", {
      value: [stub.child.stdin, stub.child.stdout, stub.child.stderr, control, lineage],
    });
    mocks.spawn.mockReturnValue(stub.child);
    let cleanup: Promise<void> | undefined;
    const starting = createServiceChildRelayAdapter({
      command: "synthetic-child",
      args: [],
      stdinMode: "pipe-open",
      oomScoreWrapperSelected: false,
      onSpawnCleanup: (promise) => {
        cleanup = promise;
      },
    });
    const start = firstMockArg(stub.sendMock, "relay start");
    if (!isRecord(start) || typeof start.generation !== "string") {
      throw new Error("Expected relay generation");
    }
    control.push(
      Buffer.from(
        encodeServiceChildMessage({
          type: "ready",
          generation: start.generation,
          sequence: 1,
          commandPid: 1234,
          anchorPid: 1235,
        }),
      ),
    );
    const { adapter, ready } = await starting;
    await ready;
    if (rootObserved) {
      control.push(
        Buffer.from(
          encodeServiceChildMessage({
            type: "root-result",
            generation: start.generation,
            sequence: 2,
            code: 0,
            signal: null,
          }),
        ),
      );
    }
    const failure = new Error("synthetic cleanup observer failed");
    adapter.onError(() => {
      throw failure;
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      control.destroy();
      await nextTurn();
      await nextTurn();
      expect(unhandled).not.toHaveBeenCalled();
      // The Gateway-side join retains failure as a value and cannot reject the process.
      await expect(Promise.allSettled([cleanup, adapter.waitForExtinction()])).resolves.toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      stub.child.stdout?.emit("end");
      stub.child.stderr?.emit("end");
      if (rootObserved) {
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      } else {
        await expect(adapter.wait()).rejects.toBe(failure);
      }
    } finally {
      process.off("unhandledRejection", unhandled);
      adapter.dispose();
      lineage.destroy();
      stub.emitExit(0);
    }
  },
);
