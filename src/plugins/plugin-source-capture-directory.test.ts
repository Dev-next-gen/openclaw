import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { sweepPluginSourceCaptureDirectories } from "./plugin-source-capture-directory.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(child.status).toBe(0);
  return child.pid;
}

function directory(root: string, name: string, old = true): string {
  const target = path.join(root, name);
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, "captured.cjs"), "module.exports = 'preserved';");
  if (old) {
    const age = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    fs.utimesSync(target, age, age);
  }
  return target;
}

it("source acquisition reclaims old dead-owner captures without removing live or unowned files", async () => {
  const root = temp.make("plugin-capture-reaping-");
  const source = temp.make("plugin-capture-input-");
  fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = 1;");
  const dead = exitedPid();
  const orphan = directory(root, `openclaw-plugin-build-${dead}-Orphan`);
  const preserved = [
    directory(root, `openclaw-plugin-build-${dead}-Recent`, false),
    directory(root, `openclaw-plugin-build-${process.pid}-Living`),
    directory(root, "openclaw-plugin-build-Legacy"),
    directory(root, "unrelated-temp-directory"),
  ];
  const outside = temp.make("plugin-capture-link-target-");
  fs.writeFileSync(path.join(outside, "sentinel"), "unrelated");
  const link = path.join(root, `openclaw-plugin-build-${dead}-SymLnk`);
  fs.symlinkSync(outside, link, "junction");

  const reads = vi.spyOn(fsPromises, "readdir");
  const artifact = withPluginSourceCaptureDirectory(root, () =>
    capturePluginGenerationArtifact(source),
  );
  try {
    // This assertion fails when source acquisition never starts orphan reclamation.
    await vi.waitFor(() => expect(fs.existsSync(orphan)).toBe(false));
    await sweepPluginSourceCaptureDirectories(root);
    for (const target of preserved) {
      expect(fs.readFileSync(path.join(target, "captured.cjs"), "utf8")).toContain("preserved");
    }
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("unrelated");
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      "module.exports = 1;",
    );
    await sweepPluginSourceCaptureDirectories(root);
    expect(reads.mock.calls.filter(([scanned]) => scanned === root)).toHaveLength(1);
  } finally {
    await artifact.disposeAsync();
  }
  expect(fs.existsSync(artifact.boundaryRoot)).toBe(false);
});

it.each(["EPERM", "EACCES"])(
  "preserves captures when owner liveness is uncertain (%s)",
  async (code) => {
    const root = temp.make("plugin-capture-uncertain-");
    const pid = exitedPid();
    const capture = directory(root, `openclaw-plugin-build-${pid}-Opaque`);
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === pid) {
        throw Object.assign(new Error("Cannot probe creator"), { code });
      }
      return kill(target, signal);
    });
    await sweepPluginSourceCaptureDirectories(root);
    expect(fs.existsSync(capture)).toBe(true);
  },
);

it.skipIf(typeof process.getuid !== "function")(
  "does not remove a capture owned by another user",
  async () => {
    const uid = process.getuid?.();
    if (uid === undefined) {
      return;
    }
    const root = temp.make("plugin-capture-user-");
    const capture = directory(root, `openclaw-plugin-build-${exitedPid()}-OwnerX`);
    const stat = fs.statSync(capture);
    vi.spyOn(fsPromises, "lstat").mockResolvedValue(Object.assign(stat, { uid: uid + 1 }));
    await sweepPluginSourceCaptureDirectories(root);
    expect(fs.existsSync(capture)).toBe(true);
  },
);
