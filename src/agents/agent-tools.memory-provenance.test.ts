import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createMemoryTurnProvenance } from "./memory-turn-provenance.js";

afterEach(() => resetPluginStateStoreForTests());

it.each([true, false])(
  "binds coding-tool provenance to owner=%s and taints after retrieval",
  async (senderIsOwner) => {
    await withStateDirEnv("coding-memory-provenance-", async ({ tempRoot }) => {
      const workspaceDir = await fs.realpath(tempRoot);
      await fs.writeFile(path.join(workspaceDir, "external.txt"), "untrusted tool content");
      const memoryTurnProvenance = createMemoryTurnProvenance();
      const tools = createOpenClawCodingTools({
        workspaceDir,
        senderIsOwner,
        memoryTurnProvenance,
      });
      const write = tools.find((tool) => tool.name === "write");
      const read = tools.find((tool) => tool.name === "read");
      if (!write || !read) {
        throw new Error("expected coding tools");
      }
      const address = { workspaceDir, relativePath: "memory/2026-07-31.md" };
      await write.execute("initial", { path: address.relativePath, content: "owner request" });
      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: senderIsOwner ? "agent" : "untrusted",
      });
      await read.execute("external", { path: "external.txt" });
      // A fresh provider/retry tool set must not reset the source's trust.
      const retryTools = createOpenClawCodingTools({
        workspaceDir,
        senderIsOwner,
        memoryTurnProvenance,
      });
      const retryWrite = retryTools.find((tool) => tool.name === "write");
      if (!retryWrite) {
        throw new Error("expected retry writer");
      }
      await retryWrite.execute("after-tool", {
        path: address.relativePath,
        content: "tool influenced",
      });
      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: "untrusted",
      });
    });
  },
);
