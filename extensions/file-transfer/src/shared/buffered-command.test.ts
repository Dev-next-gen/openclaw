import { describe, expect, it } from "vitest";
import { runCommandBuffered } from "./buffered-command.js";

describe("file-transfer bounded binary workers", () => {
  it("roundtrips binary stdin without text decoding", async () => {
    const input = Buffer.from([0, 255, 195, 0, 128]);
    const result = await runCommandBuffered(
      [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      { input, timeoutMs: 5000, maxOutputBytes: 1024 },
    );
    expect(result.termination).toBe("exit");
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual(input);
  });

  it("fails instead of accepting truncated worker output", async () => {
    const result = await runCommandBuffered(
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.alloc(8192)); setInterval(()=>{},1000)",
      ],
      { timeoutMs: 5000, maxOutputBytes: 1024 },
    );
    expect(result.termination).toBe("output-limit");
    expect(result.outputLimitStream).toBe("stdout");
    expect(result.stdout.byteLength).toBeLessThanOrEqual(1024);
  });

  it("terminates a worker that never exits", async () => {
    const result = await runCommandBuffered([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 100,
      maxOutputBytes: 1024,
    });
    expect(result.termination).toBe("timeout");
  });
});
