import { expect, test } from "vitest";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { testState } from "./test-helpers.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createSessionStoreDir, initializeRemoteBackedGitWorkspace } =
  setupGatewaySessionsWorktreeTestHarness();

test("sessions.create requires participation permission before attaching a named worktree", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-sharing-auth-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const owner = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        visibility: "draft",
        worktree: true,
        worktreeName: "private-worktree",
      },
      { client: identifiedClient("profile-owner") },
    );
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    worktreeId = owner.payload!.worktree.id;

    const denied = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "private-worktree" },
      { client: identifiedClient("profile-other") },
    );
    expect(denied).toMatchObject({ ok: false });
    expect(managedWorktrees.listSessionBindings(worktreeId, { activeOnly: true })).toEqual([
      owner.payload!.key,
    ]);
  } finally {
    const record = worktreeId ? getRegistryWorktree(process.env, worktreeId) : undefined;
    if (record && record.removedAt === undefined) {
      await managedWorktrees.remove({
        id: record.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await state.cleanup();
  }
});
