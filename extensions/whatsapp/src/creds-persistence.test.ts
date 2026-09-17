import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Whatsapp tests cover creds persistence plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueCredsSave,
  waitForCredsSaveQueueWithTimeout,
  writeWebCredsRawAtomically,
} from "./creds-persistence.js";

describe("creds-persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caps oversized credential flush timeouts before scheduling", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const authDir = "oversized-timeout";
    enqueueCredsSave(
      authDir,
      () => undefined,
      () => undefined,
    );

    await waitForCredsSaveQueueWithTimeout(authDir, Number.MAX_SAFE_INTEGER);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
  it("rechecks login authority before replacing committed credentials", async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-authority-"));
    const filePath = path.join(authDir, "creds.json");
    try {
      await fs.writeFile(filePath, "original");
      let checks = 0;
      await expect(
        writeWebCredsRawAtomically({
          filePath,
          content: "replacement",
          tempPrefix: ".creds",
          beforeCredentialPersistence: async () => {
            if (++checks > 1) {
              throw new Error("login revoked");
            }
          },
        }),
      ).rejects.toThrow("login revoked");
      expect(await fs.readFile(filePath, "utf8")).toBe("original");
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });
});
