import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itPosix = process.platform === "win32" ? it.skip : it;

itPosix.each(["empty", "legacy", "outdated"])(
  "boots an anchor handed off by an older wrapper (dependencies=%s)",
  (dependencies) => {
    const root = tempDirs.make("openclaw-pr-anchor-dependencies-");
    const canonical = join(root, "canonical");
    const anchor = join(root, "anchor");
    mkdirSync(canonical);
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      OPENCLAW_PR_ANCHOR_REPO_ROOT: canonical,
      TSX_TSCONFIG_PATH: join(anchor, "tsconfig.json"),
    };
    const initialized = spawnSync("git", ["init", canonical], { env, encoding: "utf8" });
    expect(initialized.status, initialized.stderr).toBe(0);
    copyPrWrapperSources(anchor);
    linkPrWrapperDependencies(canonical);
    if (dependencies === "legacy") {
      mkdirSync(join(anchor, "node_modules"));
      // The pre-#149585 parent only knew these four packages. Its code cannot be updated.
      for (const dependency of ["tsx", "zod", "minimatch", "yaml"]) {
        symlinkSync(
          realpathSync(join(canonical, "node_modules", dependency)),
          join(anchor, "node_modules", dependency),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    }
    if (dependencies === "outdated") {
      const obsoletePackage = join(root, "obsolete-fs-safe");
      mkdirSync(obsoletePackage);
      writeFileSync(join(obsoletePackage, "package.json"), JSON.stringify({ version: "0.5.6" }));
      const donor = join(canonical, "node_modules/@openclaw/fs-safe");
      rmSync(donor);
      symlinkSync(obsoletePackage, donor, process.platform === "win32" ? "junction" : "dir");
    }
    const bootstrap = spawnSync(join(anchor, "scripts/pr"), ["review-init"], {
      env,
      encoding: "utf8",
    });
    if (dependencies === "outdated") {
      expect(bootstrap.status, bootstrap.stderr).toBe(1);
      expect(bootstrap.stderr).toContain("has version 0.5.6; the trust anchor requires");
      expect(bootstrap.stderr).toContain(
        "Restore frozen dependencies in a clean trusted-main checkout",
      );
      expect(existsSync(join(anchor, "node_modules"))).toBe(false);
      const locks = spawnSync("git", ["-C", canonical, "for-each-ref", "refs/openclaw"], {
        env,
        encoding: "utf8",
      });
      expect(locks.status, locks.stderr).toBe(0);
      expect(locks.stdout).toBe("");
      return;
    }
    expect(bootstrap.status, bootstrap.stderr).toBe(2);
    expect(bootstrap.stdout).toContain("scripts/pr review-init <PR>");
    const provision = spawnSync(
      process.execPath,
      [
        "--import",
        join(anchor, "scripts/tsx.mjs"),
        join(anchor, "scripts/pr-lib/worktree-provision.mts"),
      ],
      { env, encoding: "utf8" },
    );
    expect(provision.status, provision.stderr).toBe(1);
    expect(provision.stderr).toContain("Usage: worktree-provision.mts");

    if (dependencies !== "legacy") {
      return;
    }
    rmSync(join(canonical, "node_modules/yaml"));
    const supervised = spawnSync(join(anchor, "scripts/pr"), ["review-init"], {
      env,
      encoding: "utf8",
    });
    expect(supervised.status, supervised.stderr).toBe(2);
    expect(supervised.stdout).toContain("scripts/pr review-init <PR>");
  },
);
