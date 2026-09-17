import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import { makeExecutable, makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import { analyzeArgvCommand, evaluateExecAllowlist, resolveSafeBins } from "./exec-approvals.js";
import { buildCwdBoundHashedArgPattern, matchAllowlist } from "./exec-command-resolution.js";
import {
  captureApprovedCwdSnapshotSync,
  revalidateApprovedCwdSnapshot,
} from "./system-run-cwd-binding.js";

describe("cwd-bound generated approvals", () => {
  it("reuses exactly approved argv only in the approved working directory", () => {
    const root = makeTempDir();
    try {
      const exe = makeExecutable(root, "status-command");
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      fs.mkdirSync(first);
      fs.mkdirSync(second);
      const env = makePathEnv(root);
      const argv = [exe, "status"];
      const analysis = analyzeArgvCommand({ argv, cwd: first, env });
      expect(analysis.ok).toBe(true);
      const entries = resolveAllowAlwaysPatternEntries({
        segments: analysis.segments,
        cwd: first,
        env,
      }).map((e) => ({
        pattern: e.pattern,
        argPattern: e.argPattern,
        source: "allow-always" as const,
      }));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.argPattern).toBe(buildCwdBoundHashedArgPattern(argv, first));
      for (const [cwd, command, allowed] of [
        [first, argv, true],
        [second, argv, false],
        [first, [exe, "reset"], false],
      ] as const) {
        const current = analyzeArgvCommand({ argv: [...command], cwd, env });
        expect(
          evaluateExecAllowlist({
            analysis: current,
            allowlist: entries,
            safeBins: resolveSafeBins(undefined),
            cwd,
            env,
          }).allowlistSatisfied,
        ).toBe(allowed);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects obsolete generated rules but preserves hand-authored rules", () => {
    const resolution = {
      rawExecutable: "/usr/bin/git",
      resolvedPath: "/usr/bin/git",
      executableName: "git",
    };
    for (const argPattern of [undefined, "^status$", "sha256:argv:legacy"]) {
      expect(
        matchAllowlist(
          [{ pattern: "/usr/bin/git", source: "allow-always", argPattern }],
          resolution,
          ["/usr/bin/git", "status"],
          "linux",
          "/workspace",
        ),
      ).toBeNull();
    }
    expect(
      matchAllowlist(
        [{ pattern: "/usr/bin/git" }],
        resolution,
        ["/usr/bin/git", "status"],
        "linux",
        "/workspace",
      ),
    ).not.toBeNull();
  });

  it("detects replacement of the approved directory object", () => {
    const root = makeTempDir();
    try {
      const cwd = path.join(root, "cwd");
      fs.mkdirSync(cwd);
      const captured = captureApprovedCwdSnapshotSync(cwd);
      expect(captured.ok).toBe(true);
      if (!captured.ok) {
        throw new Error(captured.message);
      }
      expect(revalidateApprovedCwdSnapshot(captured.snapshot)).toBe(true);
      fs.renameSync(cwd, path.join(root, "old"));
      fs.mkdirSync(cwd);
      expect(revalidateApprovedCwdSnapshot(captured.snapshot)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
