import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itPosix = process.platform === "win32" ? it.skip : it;

itPosix.each([false, true])("launches a pre-helper anchor (manifest=%s)", (manifest) => {
  const root = tempDirs.make("openclaw-pr-legacy-anchor-");
  const canonical = join(root, "canonical");
  const linked = join(root, "linked");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "OpenClaw Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "OpenClaw Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git(root, "init", "-b", "main", canonical);
  mkdirSync(join(canonical, "scripts/pr-lib"), { recursive: true });
  const wrapper = join(canonical, "scripts/pr");
  // The old entrypoint understands the verified handoff but has no dependency helper.
  writeFileSync(
    wrapper,
    '#!/bin/bash\n# OPENCLAW_PR_ANCHOR_REPO_ROOT\nexec node "$(dirname "$0")/pr-lib/legacy-entry.mjs"\n',
  );
  chmodSync(wrapper, 0o755);
  writeFileSync(
    join(canonical, "scripts/pr-lib/legacy-entry.mjs"),
    `import "${manifest ? "@openclaw/fs-safe/config" : "yaml"}";\nconsole.log("legacy anchor loaded");\n`,
  );
  writeFileSync(
    join(canonical, "scripts/pr-lib/wrapper-components.txt"),
    `${manifest ? "package.json\n" : ""}scripts/pr-lib/legacy-entry.mjs\n`,
  );
  if (manifest) {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    packageJson.dependencies["@openclaw/fs-safe"] = "0.0.0-fixture";
    writeFileSync(join(canonical, "package.json"), JSON.stringify(packageJson));
  }
  git(canonical, "add", ".");
  git(canonical, "commit", "-m", "test: pre-helper anchor");
  git(canonical, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(canonical, "worktree", "add", "-b", "caller", linked);
  copyFileSync("scripts/pr", join(linked, "scripts/pr"));
  copyFileSync(
    "scripts/pr-lib/materialize-dependencies.mjs",
    join(linked, "scripts/pr-lib/materialize-dependencies.mjs"),
  );
  git(linked, "add", "scripts");
  git(linked, "commit", "-m", "test: newer caller");
  git(canonical, "checkout", "-b", "parked");
  writeFileSync(wrapper, `${readFileSync(wrapper, "utf8")}# parked\n`);
  git(canonical, "commit", "-am", "test: park canonical wrapper");
  linkPrWrapperDependencies(canonical);
  if (manifest) {
    // The anchor's required version can differ from the newer parent's manifest.
    const dependency = join(root, "older-fs-safe");
    mkdirSync(dependency);
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "@openclaw/fs-safe",
        version: "0.0.0-fixture",
        type: "module",
        exports: { "./config": "./config.js" },
      }),
    );
    writeFileSync(join(dependency, "config.js"), "export {};\n");
    const installed = join(canonical, "node_modules/@openclaw/fs-safe");
    rmSync(installed);
    symlinkSync(dependency, installed, "dir");
  }

  const result = spawnSync(join(linked, "scripts/pr"), ["review-init"], {
    cwd: linked,
    env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("running wrapper code materialized from");
  expect(result.stdout).toBe("legacy anchor loaded\n");
  expect(git(canonical, "for-each-ref", "refs/openclaw")).toBe("");
});
