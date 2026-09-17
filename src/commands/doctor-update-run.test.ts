import { afterEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { listUpdateRunsAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../infra/update-run-reader.js", () => ({ listUpdateRunsAsync: vi.fn() }));

afterEach(() => vi.resetAllMocks());

it.each([
  {
    reason: "node-runtime-preflight",
    nextAction:
      "openclaw@2026.9.4 requires Node >=24.16.0; selected runtime is Node 22.23.2; with nvm, run `nvm install 24.16.0 && nvm use 24.16.0`, then rerun `openclaw update`.",
  },
  {
    reason: "global-install-permission-denied",
    nextAction:
      "Cannot write /opt/openclaw-prefix/lib/node_modules (owned by root); run `openclaw update` as root, the installation owner.",
  },
])("keeps $reason remediation visible until a later successful update", async (failure) => {
  let latest: UpdateRunRecord = {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: failure.reason,
    origin: { nextAction: failure.nextAction },
    target: { kind: "package", version: "2026.9.4" },
    before: { version: "2026.7.1-2" },
    after: {},
    steps: [{ step: failure.reason, status: "failed", detail: failure.nextAction }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
  };
  vi.mocked(listUpdateRunsAsync).mockImplementation(async (input) =>
    input?.active ? [] : [latest],
  );

  await noteStaleUpdateRuns({});

  expect(note).toHaveBeenCalledOnce();
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining(`OpenClaw update failed: ${failure.reason}`),
    "Update history",
  );
  expect(note).toHaveBeenCalledWith(expect.stringContaining(failure.nextAction), "Update history");

  latest = {
    ...latest,
    runId: "e8a1ac89-4a31-41f6-b401-4b225b661728",
    createdAtMs: 3,
    updatedAtMs: 4,
    finishedAtMs: 4,
    status: "succeeded",
    reason: null,
    origin: {},
    after: { version: "2026.9.4" },
    steps: [],
  };
  vi.mocked(note).mockClear();

  await noteStaleUpdateRuns({});

  expect(note).not.toHaveBeenCalled();
});
