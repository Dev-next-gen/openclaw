import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  countObsoleteGeneratedExecApprovals,
  repairObsoleteGeneratedExecApprovals,
} from "./exec-approvals-generated-migration.js";
import type { ExecApprovalsFile } from "./exec-approvals.js";
import {
  loadExecApprovals as loadExecApprovalsReadOnly,
  saveExecApprovals,
  addAllowlistEntry,
} from "./exec-approvals.js";
import { buildCwdBoundHashedArgPattern } from "./exec-command-resolution.js";

describe("generated exec approval migration", () => {
  it("removes inactive generated grants without changing manual or cwd-bound rules", async () => {
    await withTempDir({ prefix: "openclaw-exec-approval-migration-" }, async (home) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
      closeOpenClawStateDatabaseForTest();

      try {
        const current = buildCwdBoundHashedArgPattern(["/usr/bin/git", "status"], "/workspace");
        const file: ExecApprovalsFile = {
          version: 1,
          agents: {
            main: {
              allowlist: [
                { pattern: "/usr/bin/git", source: "allow-always" },
                {
                  pattern: "/usr/bin/curl",
                  source: "allow-always",
                  argPattern: "sha256:argv:obsolete",
                },
                {
                  pattern: "C:\\Tools\\rg.exe",
                  source: "allow-always",
                  argPattern: "^--json\0$",
                },
                { pattern: "/usr/bin/git", source: "allow-always", argPattern: current },
                { pattern: "/usr/bin/python3", argPattern: "^script\\.py$" },
                { pattern: "=node-command:marker", source: "allow-always" },
              ],
            },
          },
        };
        saveExecApprovals(file);

        // Renewing an already-present scoped grant must still persist removal of
        // older grants for the same executable; unrelated grants survive until repair.
        addAllowlistEntry(file, "main", "/usr/bin/git", {
          source: "allow-always",
          argPattern: current,
        });
        expect(countObsoleteGeneratedExecApprovals(loadExecApprovalsReadOnly())).toBe(2);
        expect(repairObsoleteGeneratedExecApprovals()).toBe(2);
        expect(loadExecApprovalsReadOnly().agents?.main?.allowlist).toEqual([
          expect.objectContaining({
            pattern: "/usr/bin/git",
            source: "allow-always",
            argPattern: current,
          }),
          expect.objectContaining({ pattern: "/usr/bin/python3", argPattern: "^script\\.py$" }),
          expect.objectContaining({ pattern: "=node-command:marker", source: "allow-always" }),
        ]);
      } finally {
        closeOpenClawStateDatabaseForTest();

        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });
});
