import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { DeleteSessionEntryLifecycleParams } from "./session-accessor.lifecycle-types.js";
import {
  deleteDiskBudgetSessionEntryLifecycle,
  deleteSessionEntryLifecycle,
} from "./session-accessor.sqlite-lifecycle.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";

const boundary = vi.hoisted(() => ({
  queue: vi.fn(async (_scope: ResolvedSqliteScope, _run: () => Promise<unknown>) => null),
  state: vi.fn((databasePath: string) => ({
    assertCurrent() {},
    databasePath,
    identity: { key: databasePath },
  })),
  agentPath: (options: OpenClawAgentDatabaseOptions) =>
    options.path ?? `${options.env?.OPENCLAW_STATE_DIR}/${options.agentId}.sqlite`,
}));

// This suite exercises the lifecycle and archive-session captures without opening a database.
vi.mock("../../routing/session-key.js", () => ({ parseAgentSessionKey: () => undefined }));
vi.mock("../../sessions/agent-harness-session-key.js", () => ({}));
vi.mock("../../sessions/session-lifecycle-events.js", () => ({}));
vi.mock("../../state/github-personal-publication-lifecycle.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({}));
vi.mock("../../state/openclaw-agent-db.js", () => ({
  deferOpenClawAgentPostCommitPublication: vi.fn(),
  openOpenClawAgentDatabase: vi.fn(),
  resolveOpenClawAgentSqlitePath: boundary.agentPath,
}));
vi.mock("../../state/openclaw-agent-db.paths.js", () => ({
  resolveOpenClawAgentSqlitePath: boundary.agentPath,
}));
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: () => () => {},
}));
vi.mock("../../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: boundary.state,
  registerOpenClawStateDatabaseAsyncResource: () => () => {},
}));
vi.mock("../../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: (env?: NodeJS.ProcessEnv) =>
    `${env?.OPENCLAW_STATE_DIR}/state/openclaw.sqlite`,
}));
vi.mock("./session-accessor.sqlite-archive-store.js", () => ({
  publishSessionStateArchives: async () => [],
}));
vi.mock("./session-accessor.sqlite-archive.js", () => ({}));
vi.mock("./session-accessor.sqlite-deletion.js", () => ({}));
vi.mock("./session-accessor.sqlite-entry-equality.js", () => ({}));
vi.mock("./session-accessor.sqlite-entry-store.js", () => ({}));
vi.mock("./session-accessor.sqlite-events.js", () => ({}));
vi.mock("./session-accessor.sqlite-lifecycle-artifacts.js", () => ({}));
vi.mock("./session-accessor.sqlite-lifecycle-state.js", () => ({}));
vi.mock("./session-accessor.sqlite-maintenance.js", () => ({}));
vi.mock("./session-accessor.sqlite-reclamation.js", () => ({}));
vi.mock("./session-accessor.sqlite-reset-boundary.js", () => ({}));
vi.mock("./session-accessor.sqlite-scope.js", () => ({
  resolveSqliteAgentId: (params: { scopedAgentId?: string; storeAgentId?: string }) =>
    params.scopedAgentId ?? params.storeAgentId,
  resolveSqliteStoreScope: (_storePath: string, options: { agentId?: string }) => ({
    agentId: options.agentId ?? "main",
    sessionKey: "",
  }),
  runExclusiveSqliteSessionWrite: boundary.queue,
  toDatabaseOptions: (scope: ResolvedSqliteScope) => ({
    agentId: scope.databaseAgentId ?? scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.path ? { path: scope.path } : {}),
  }),
}));
vi.mock("./session-history-eviction.js", () => ({
  collectAdmissionProtectedSessionIds: () => new Set(),
  kickSessionHistoryDiskBudgetMaintenance: () => {},
}));

const deleteParams: DeleteSessionEntryLifecycleParams = {
  agentId: "main",
  archiveTranscript: false,
  storePath: "/synthetic/store",
  target: { canonicalKey: "agent:main:capture", storeKeys: [] },
};

const fixtures = [
  { platform: "win32", key: "OpenClaw_State_Dir", readonlyKey: "OpenClaw_Config_Readonly" },
  { platform: "linux", key: "OPENCLAW_STATE_DIR", readonlyKey: "OPENCLAW_CONFIG_READONLY" },
  { platform: "linux", key: "OpenClaw_State_Dir", readonlyKey: "OpenClaw_Config_Readonly" },
] as const;

const root = path.resolve("/synthetic/captured");
const home = path.resolve("/synthetic/home");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function expectCapturedRoot(fixture: (typeof fixtures)[number]) {
  const caseSensitiveMiss = fixture.platform === "linux" && fixture.key !== "OPENCLAW_STATE_DIR";
  const expectedRoot = caseSensitiveMiss ? path.join(home, ".openclaw") : root;
  const queued = boundary.queue.mock.calls[0]?.[0];
  expect(queued?.path).toBe(`${expectedRoot}/main.sqlite`);
  expect(queued?.env?.OPENCLAW_STATE_DIR).toBe(expectedRoot);
  expect(queued?.env?.OPENCLAW_CONFIG_READONLY).toBe(caseSensitiveMiss ? undefined : "1");
  // The archive session must pin the same state database as the lifecycle owner.
  expect(boundary.state).toHaveBeenCalledWith(`${expectedRoot}/state/openclaw.sqlite`);
}

it.each([
  ...fixtures.map((fixture) => ({ ...fixture, input: "plain" })),
  { ...fixtures[0], input: "precloned" },
])("retains $input disk-budget delete environment on $platform with $key", async (fixture) => {
  await withMockedPlatform(fixture.platform, async () => {
    const rawEnv = {
      [fixture.key]: root,
      [fixture.readonlyKey]: "1",
      HOME: home,
      OPENCLAW_TEST_FAST: "1",
    };
    const env = fixture.input === "precloned" ? cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;
    await expect(
      deleteDiskBudgetSessionEntryLifecycle(deleteParams, { agentId: "main", env, sessionKey: "" }),
    ).resolves.toMatchObject({ deleted: false });
    expectCapturedRoot(fixture);
    expect(env[fixture.key]).toBe(root);
    expect(Object.keys(env)).toEqual(Object.keys(rawEnv));
  });
});

it.each(fixtures)("retains process delete environment on $platform with $key", async (fixture) => {
  await withMockedPlatform(fixture.platform, async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_READONLY", undefined);
    vi.stubEnv("OPENCLAW_HOME", undefined);
    vi.stubEnv(fixture.key, root);
    vi.stubEnv(fixture.readonlyKey, "1");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    await expect(deleteSessionEntryLifecycle(deleteParams)).resolves.toMatchObject({
      deleted: false,
    });
    expectCapturedRoot(fixture);
    expect(process.env[fixture.key]).toBe(root);
  });
});
