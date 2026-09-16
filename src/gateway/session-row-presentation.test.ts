import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createExpectedProfileBinding,
  ExpectedProfileMismatchError,
  prepareGatewayRecipientProfile,
  resolvePreparedSessionProfileId,
} from "./expected-profile.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  prepareProjectedSessionPresentation,
  presentProjectedSessionSnapshot,
} from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("presents current recipient roles without SQLite while rejecting source overrides and excluded children", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("owner@presentation.test");
    const member = ensureProfileForEmail("member@presentation.test");
    const viewer = ensureProfileForEmail("viewer@presentation.test");
    setUserProfileRole(viewer.id, "none");
    const clients = [owner, member, viewer].map((profile) => {
      const client = sharingPolicyClient({ user: profile.id }) as GatewayWsClient;
      prepareGatewayRecipientProfile(client);
      return client;
    });
    const cfg = rolePolicyConfig();
    const query = { agentId: "main", key: "agent:main:parent" };
    const scope = { agentId: "main", sessionKey: query.key };
    const entry = {
      sessionId: "parent-session",
      updatedAt: Date.now(),
      visibility: "suggest" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
    };
    replaceSessionEntrySync(scope, entry);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:child" },
      {
        sessionId: "child-session",
        updatedAt: Date.now(),
        parentSessionKey: query.key,
      },
    );
    addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
    const projection = await createSessionRowProjection({ cfg });
    try {
      const captured = projection.describe(query)!;
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      expect(
        prepareProjectedSessionPresentation(projection).present(captured)?.sharingRole,
      ).toBeUndefined();
      for (const [index, expectedRole, visible] of [
        [0, "owner", true],
        [1, "member", true],
        [2, "viewer", false],
      ] as const) {
        const client = clients[index]!;
        const presentation = prepareProjectedSessionPresentation(projection, client);
        expect(
          presentation.present(captured, { excludedChildKeys: new Set(["agent:main:child"]) }),
        ).toMatchObject({ sharingRole: expectedRole });
        expect(
          presentation.present(captured, { excludedChildKeys: new Set(["agent:main:child"]) })
            ?.childSessions,
        ).toBeUndefined();
        expect(
          canReceiveSessionEvent({
            cfg,
            client,
            sessionKeys: [query.key],
            agentId: "main",
            prepared: {
              sharing: presentation.sharing,
              target: (key) => presentation.target({ ...query, key }),
            },
          }),
        ).toBe(visible);
        expect(presentation.authorizeDescription(query)).toBeNull();
        const snapshot = presentProjectedSessionSnapshot(projection, query, {
          client,
          sourceRow: {
            key: query.key,
            sessionId: entry.sessionId,
            label: null,
            endedAt: null,
            status: "completed",
            activitySummary: { state: "stale", text: "Retained event summary" },
          },
        });
        expect(snapshot.row).toEqual(presentation.present(captured));
        expect(snapshot.row).not.toMatchObject({ status: "completed", label: null });
      }
      expect(
        prepareProjectedSessionPresentation(projection, clients[0]!).authorizeDescription({
          agentId: "main",
          key: "agent:main:dashboard:incognito-private",
        }),
      ).toMatchObject({ code: "INVALID_REQUEST" });
      expect(prepares).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      prepares.mockRestore();
      exec.mockRestore();
      removeSessionMember(scope, member.id);
      await projection.ensureMaterialized();
      expect(
        prepareProjectedSessionPresentation(projection, clients[1]!).snapshot(query).row
          ?.sharingRole,
      ).toBe("viewer");
      replaceSessionEntrySync(scope, { ...entry, sessionId: "replacement-session" });
      await projection.ensureMaterialized();
      expect(
        prepareProjectedSessionPresentation(projection, clients[0]!).present(captured),
      ).toBeNull();
      expect(
        presentProjectedSessionSnapshot(projection, query, {
          client: clients[0]!,
          sourceRow: { sessionId: entry.sessionId },
        }).row,
      ).toBeNull();
    } finally {
      projection.dispose();
    }
  });
});

it("checks selected profile identity from current prepared facts without following the requested ID through a merge", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const source = ensureProfileForEmail("source@expected-profile.test");
    const target = ensureProfileForEmail("target@expected-profile.test");
    const client = sharingPolicyClient({ user: source.id }) as GatewayWsClient;
    prepareGatewayRecipientProfile(client);
    const binding = createExpectedProfileBinding(source.id, client, () =>
      resolvePreparedSessionProfileId(client),
    )!;
    const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
    binding.assertCurrent();
    const response = vi.fn();
    binding.guardResponse(response)(true, { session: null });
    expect(response).toHaveBeenCalledWith(true, { session: null });
    expect(prepares).not.toHaveBeenCalled();
    prepares.mockRestore();
    linkEmail("source@expected-profile.test", target.id);
    prepareGatewayRecipientProfile(client);
    const afterMerge = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(() => binding.assertCurrent()).toThrow(ExpectedProfileMismatchError);
    expect(resolvePreparedSessionProfileId(client)).toBe(target.id);
    expect(afterMerge).not.toHaveBeenCalled();
  });
});
