import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import * as titles from "./session-transcript-title-reader.js";

afterEach(() => vi.restoreAllMocks());

it("heals resident titles after reconciliation without a transcript mutation or clean-read SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:recovered-title",
      sessionId: "recovered-title",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      visibility: "shared",
      updatedAt: Date.now(),
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { message: { role: "user", content: "Explain the recovered session" } },
        { message: { role: "assistant", content: "The existing reply is available again." } },
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const events = database.db.prepare(
      "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
    );
    const originalEvents = events.all(scope.sessionId);
    const context = requestContext(cfg);
    const client = identifiedClient("owner@example.com");
    const options = { includeDerivedTitles: true, includeLastMessage: true };
    // Model the optional reader's unavailable result without racing automatic reconciliation.
    const titleRead = vi.spyOn(titles, "readSessionTitleFieldsFromTranscript").mockReturnValue({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    const transcriptUpdates = vi.fn();
    const stop = onInternalSessionTranscriptUpdate(transcriptUpdates);
    try {
      const initial = await listSessions({ context, client, request: options });
      expect(initial.sessions).toEqual([
        expect.objectContaining({
          key: scope.sessionKey,
          derivedTitle: undefined,
          lastMessagePreview: undefined,
        }),
      ]);
      titleRead.mockRestore();
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(scope.sessionId);
      await expect(
        reconcileSessionTranscriptIndexes({ agentId: scope.agentId, path: database.path }),
      ).resolves.toEqual({ reconciledSessions: 1 });
      const projection = context.getSessionRowProjection!()!;
      await projection.ensureMaterialized();
      expect(transcriptUpdates).not.toHaveBeenCalled();
      expect(events.all(scope.sessionId)).toEqual(originalEvents);

      const expected = {
        key: scope.sessionKey,
        derivedTitle: "Explain the recovered session",
        lastMessagePreview: "The existing reply is available again.",
      };
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const execs = vi.spyOn(DatabaseSync.prototype, "exec");
      const nativeCalls = (["all", "get", "iterate", "run"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      const healed = await listSessions({ context, client, request: options });
      expect(healed.sessions).toEqual([expect.objectContaining(expected)]);
      const respond = vi.fn();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "recovered-describe", method: "sessions.describe" },
        params: { key: scope.sessionKey, ...options },
        context,
        client,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        session: expect.objectContaining(expected),
      });
      expect(
        projection.snapshot({ agentId: scope.agentId, key: scope.sessionKey }, options).row,
      ).toMatchObject(expected);
      expect(prepares).not.toHaveBeenCalled();
      expect(execs).not.toHaveBeenCalled();
      for (const calls of nativeCalls) {
        expect(calls).not.toHaveBeenCalled();
      }
    } finally {
      stop();
      context.getSessionRowProjection?.()?.dispose();
      vi.restoreAllMocks();
    }
  });
});
