import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import {
  listSessionEntriesReadOnlyAsync,
  readSessionListPageReadOnlyAsync,
  readSessionListPageReadOnlyCurrent,
} from "./session-accessor.sqlite-list-read.js";
import { addSessionMember } from "./session-sharing-store.js";

afterEach(() => vi.restoreAllMocks());

it("lists more stores than the broker can retain without evicting active reads or final page observers", async () => {
  await withOpenClawTestState({ label: "session-list-backend-capacity" }, async (state) => {
    const seed = async (name: string) => {
      const agentId = `capacity-${name}`;
      const sessionKey = `agent:${agentId}:entry`;
      const scope = { agentId, sessionKey, env: state.env, projection: "list" as const };
      replaceSessionEntrySync(scope, { sessionId: sessionKey, updatedAt: 1, label: name });
      addSessionMember(scope, { identityId: "viewer", addedBy: "owner" });
      const databasePath = openOpenClawAgentDatabase(scope).path;
      await closeOpenClawAgentDatabaseByPathAsync(databasePath, agentId);
      return { scope, databasePath };
    };
    const heldStore = await seed("held");
    const delivered = createDeferredCore();
    const release = createDeferredCore();
    // oxlint-disable-next-line typescript/unbound-method -- call restores the intercepted broker receiver below.
    const original = SqliteWorkerBroker.prototype.runOperation;
    vi.spyOn(SqliteWorkerBroker.prototype, "runOperation").mockImplementationOnce(async function (
      this: SqliteWorkerBroker,
      ...args
    ) {
      const value = await original.call(this, ...args);
      delivered.resolve();
      await release.promise;
      return value;
    });
    const held = listSessionEntriesReadOnlyAsync(heldStore.scope);
    let heldSettled = false;
    void held.then(
      () => {
        heldSettled = true;
      },
      () => {
        heldSettled = true;
      },
    );
    try {
      await Promise.race([delivered.promise, held]);
      expect(heldSettled).toBe(false);
      const stores: Array<Awaited<ReturnType<typeof seed>>> = [];
      // The shared broker permits 64 clients, including unrelated database consumers.
      for (let index = 0; index < 65; index++) {
        const store = await seed(String(index));
        stores.push(store);
        expect(await listSessionEntriesReadOnlyAsync(store.scope)).toMatchObject([
          { sessionKey: store.scope.sessionKey, entry: { label: String(index) } },
        ]);
      }
      const scopes = stores.map(({ scope }) => ({ ...scope, sessionKeys: [scope.sessionKey] }));
      const page = await readSessionListPageReadOnlyAsync(scopes, {
        membershipIdentityId: "viewer",
      });
      expect(page).toMatchObject(
        stores.map(({ scope }) => ({
          ok: true,
          value: {
            entries: [{ sessionKey: scope.sessionKey }],
            membershipKeys: [scope.sessionKey],
          },
        })),
      );
      expect(heldSettled).toBe(false);

      const first = stores[0]!;
      const external = new DatabaseSync(first.databasePath);
      try {
        external
          .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
          .run(first.scope.sessionKey, "viewer");
      } finally {
        external.close();
      }
      // Old backend eviction must leave every selected store's admitted observer usable.
      expect(
        readSessionListPageReadOnlyCurrent(scopes, { membershipIdentityId: "viewer" }),
      ).toMatchObject(
        stores.map(({ scope }, index) => ({
          ok: true,
          value: {
            entries: [{ sessionKey: scope.sessionKey }],
            membershipKeys: index === 0 ? [] : [scope.sessionKey],
          },
        })),
      );
      expect(stores.every(({ databasePath }) => !isOpenClawAgentDatabaseOpen(databasePath))).toBe(
        true,
      );
      release.resolve();
      expect(await held).toMatchObject([
        { sessionKey: heldStore.scope.sessionKey, entry: { label: "held" } },
      ]);

      await closeOpenClawAgentDatabaseByPathAsync(first.databasePath, first.scope.agentId);
      expect(await listSessionEntriesReadOnlyAsync(first.scope)).toMatchObject([
        { sessionKey: first.scope.sessionKey, entry: { label: "0" } },
      ]);
      expect(
        await readSessionListPageReadOnlyAsync([scopes[0]!], { membershipIdentityId: "viewer" }),
      ).toMatchObject([{ ok: true, value: { membershipKeys: [] } }]);
      expect(isOpenClawAgentDatabaseOpen(first.databasePath)).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([held]);
    }
  });
});
