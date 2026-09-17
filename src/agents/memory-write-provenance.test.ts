import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createHostWorkspaceWriteTool,
  createHostWorkspaceEditTool,
  wrapToolMemoryFlushAppendOnlyWrite,
} from "./agent-tools.read.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("memory write provenance", () => {
  it("tracks all host coding mutations and append-only flushes through one observer", async () => {
    await withStateDirEnv("openclaw-memory-provenance-", async ({ tempRoot }) => {
      const workspaceDir = await fs.realpath(tempRoot);
      let originClass: "agent" | "untrusted" = "agent";
      const observer = createMemoryWriteProvenanceObserver({
        mutationRoot: workspaceDir,
        workspaceDir,
        resolveOriginClass: () => originClass,
      });
      const relativePath = "memory/new/daily.md";
      const write = createHostWorkspaceWriteTool(workspaceDir, {
        workspaceOnly: true,
        memoryWriteProvenance: observer,
      });
      await write.execute("write", { path: relativePath, content: "original" });
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath }),
      ).resolves.toMatchObject({ originClass: "agent" });
      originClass = "untrusted";
      const edit = createHostWorkspaceEditTool(workspaceDir, {
        workspaceOnly: true,
        memoryWriteProvenance: observer,
      });
      await edit.execute("edit", {
        path: relativePath,
        edits: [{ oldText: "original", newText: "external" }],
      });
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
      const patch = createApplyPatchTool({ cwd: workspaceDir, memoryWriteProvenance: observer });
      await patch.execute("patch", {
        input: "*** Begin Patch\n*** Add File: memory/patch.md\n+external patch\n*** End Patch",
      });
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/patch.md" }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
      const flush = wrapToolMemoryFlushAppendOnlyWrite(write, {
        root: workspaceDir,
        relativePath,
        memoryWriteProvenance: observer,
      });
      await flush.execute("flush", { path: relativePath, content: "flush" });
      expect(await fs.readFile(path.join(workspaceDir, relativePath), "utf8")).toBe(
        "external\nflush",
      );
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
    });
  });

  it("rolls provenance back when the filesystem write fails", async () => {
    await withStateDirEnv("openclaw-memory-provenance-", async ({ tempRoot }) => {
      const observer = createMemoryWriteProvenanceObserver({
        mutationRoot: tempRoot,
        workspaceDir: tempRoot,
        resolveOriginClass: () => "untrusted",
        now: () => 1,
      });
      const commit = vi.fn(async () => {
        throw new Error("disk full");
      });

      await expect(
        observer.write({
          absolutePath: `${tempRoot}/MEMORY.md`,
          contentBefore: "before",
          contentAfter: "after",
          commit,
        }),
      ).rejects.toThrow("disk full");
      await expect(
        readMemoryArtifactProvenance({ workspaceDir: tempRoot, relativePath: "MEMORY.md" }),
      ).resolves.toBeUndefined();
      expect(commit).toHaveBeenCalledOnce();
    });
  });
});
