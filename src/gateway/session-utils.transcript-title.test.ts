import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const NOW = Date.UTC(2026, 8, 15);
const NAMED_PAYLOAD_MARKER = "named transcript payload ";
const NAMED_PAYLOAD = NAMED_PAYLOAD_MARKER.repeat(3_000);
type RowDefinition = {
  entry?: Partial<SessionEntry>;
  key?: string;
  transcript?: "named" | "unknown";
};

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

async function withTitleRows(
  definitions: RowDefinition[],
  run: (fixture: {
    render: (
      mode: "scalar" | "batch",
      includeLastMessage?: boolean,
    ) => Promise<GatewaySessionRow[]>;
    queries: ReturnType<typeof trackSqliteStatementExecutions<"events">>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "session-title-hydration" }, async (state) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: { model: { primary: "openai/gpt-5" }, thinkingDefault: "off" },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(createEmptyPluginRegistry());
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const store: Record<string, SessionEntry> = {};
    const persistedScopes: Array<SessionTranscriptReadScope & { sessionKey: string }> = [];
    for (const [index, definition] of definitions.entries()) {
      const key = definition.key ?? `agent:main:dashboard:title-${index}`;
      const entry: SessionEntry = {
        sessionId: `title-${index}`,
        updatedAt: NOW - index,
        ...definition.entry,
      };
      store[key] = entry;
      if (!entry.sessionId || !definition.transcript) {
        continue;
      }
      const scope = { agentId: "main", storePath, sessionKey: key, sessionId: entry.sessionId };
      replaceSessionEntrySync(scope, entry);
      persistedScopes.push(scope);
      for (const message of [
        { role: "user", content: `Find result ${index}.` },
        {
          role: "assistant",
          content: `Preview ${index}. ${definition.transcript === "named" ? NAMED_PAYLOAD : ""}`,
        },
      ]) {
        expect(appendTranscriptMessageSync(scope, { message }).ok).toBe(true);
      }
    }
    const persistedState = () =>
      persistedScopes.map((scope) => ({
        entry: loadSessionEntryReadOnly(scope),
        watermark: readSessionTranscriptWatermark(scope),
      }));
    const before = persistedState();
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const queries = trackSqliteStatementExecutions(database.db, ["events"], (sql) =>
      /^select\b[\s\S]*\bevent_json\b/i.test(sql) ? "events" : null,
    );
    try {
      await run({
        queries,
        render: async (mode, includeLastMessage = false) => {
          if (mode === "batch") {
            return (
              await listSessionFixture({
                cfg,
                storePath,
                store,
                opts: {
                  includeDerivedTitles: true,
                  includeLastMessage,
                  limit: definitions.length,
                },
              })
            ).sessions;
          }
          return Object.entries(store).map(([key, entry]) =>
            buildGatewaySessionRow({
              cfg,
              agentId: "main",
              storePath,
              store,
              key,
              entry,
              now: NOW,
              includeDerivedTitles: true,
              includeLastMessage,
              skipTranscriptUsageFallback: true,
              lightweightListRow: true,
            }),
          );
        },
      });
    } finally {
      queries.restore();
    }
    expect(persistedState()).toEqual(before);
  });
}

function withoutPreviews(rows: GatewaySessionRow[]) {
  return rows.map((row) => ({ ...row, lastMessagePreview: undefined }));
}

test.each(["scalar", "batch"] as const)(
  "does not hydrate named transcript payloads for %s title-only rows",
  async (mode) => {
    await withTitleRows(
      (
        [
          { entry: { label: "  Explicit title  ", displayName: "Stored", subject: "Subject" } },
          { entry: { displayName: "  Stored title  ", subject: "Subject" } },
          { entry: { label: " \t ", displayName: "  ", subject: " Subject title " } },
          { entry: { autoLabel: "Generated title" } },
          {
            key: "agent:main:telegram:group:42",
            entry: {
              chatType: "group",
              subject: "Human group title",
              displayName: "telegram:g-42",
            },
          },
          {
            key: "agent:main:telegram:direct:42",
            entry: {
              delivery: normalizeSessionDeliveryState({
                context: { channel: "telegram", to: "42" },
                origin: { label: "Readable origin title" },
              }),
            },
          },
        ] satisfies RowDefinition[]
      ).map((definition) => Object.assign({}, definition, { transcript: "named" as const })),
      async ({ render, queries }) => {
        const parse = vi.spyOn(JSON, "parse");
        const titles = await render(mode);
        expect(titles.map((row) => row.derivedTitle)).toEqual([
          "Explicit title",
          "Stored title",
          "Subject title",
          "Generated title",
          "Human group title",
          "Readable origin title",
        ]);
        expect(queries.textBytes.events).toBe(0);
        expect(parse.mock.calls.some(([json]) => json.includes(NAMED_PAYLOAD_MARKER))).toBe(false);

        // A preview request still reads the same persisted payload and preserves every title.
        const previews = await render(mode, true);
        expect(queries.textBytes.events).toBeGreaterThan(NAMED_PAYLOAD.length * titles.length);
        expect(previews.every((row) => row.lastMessagePreview?.startsWith("Preview"))).toBe(true);
        expect(JSON.stringify(withoutPreviews(previews))).toBe(JSON.stringify(titles));
        parse.mockRestore();
      },
    );
  },
);

test.each(["scalar", "batch"] as const)(
  "keeps unresolved %s titles aligned between named and missing-session rows",
  async (mode) => {
    await withTitleRows(
      [
        { entry: { label: "First named title" }, transcript: "named" },
        { entry: { label: " ", displayName: "\t", subject: " " }, transcript: "unknown" },
        { entry: { sessionId: "", label: "No transcript identity" } },
        { entry: { displayName: "Second named title" }, transcript: "named" },
        { transcript: "unknown" },
      ],
      async ({ render, queries }) => {
        const parse = vi.spyOn(JSON, "parse");
        const titles = await render(mode);
        expect(titles.map((row) => row.derivedTitle)).toEqual([
          "First named title",
          "Find result 1.",
          undefined,
          "Second named title",
          "Find result 4.",
        ]);
        expect(queries.textBytes.events).toBeGreaterThan(0);
        expect(queries.textBytes.events).toBeLessThan(4_096);
        expect(parse.mock.calls.some(([json]) => json.includes(NAMED_PAYLOAD_MARKER))).toBe(false);
        const previews = await render(mode, true);
        expect(previews.map((row) => row.lastMessagePreview?.slice(0, 10))).toEqual([
          "Preview 0.",
          "Preview 1.",
          undefined,
          "Preview 3.",
          "Preview 4.",
        ]);
        expect(JSON.stringify(withoutPreviews(previews))).toBe(JSON.stringify(titles));
        parse.mockRestore();
      },
    );
  },
);

test("keeps the transcript page budget when named rows need no hydration", async () => {
  await withTitleRows(
    Array.from({ length: 101 }, (_, index) =>
      index < 99 ? { entry: { label: `Named ${index}` } } : { transcript: "unknown" as const },
    ),
    async ({ render }) => {
      const rows = await render("batch");
      expect(rows).toHaveLength(101);
      expect(rows[0]?.derivedTitle).toBe("Named 0");
      expect(rows[98]?.derivedTitle).toBe("Named 98");
      expect(rows[99]?.derivedTitle).toBe("Find result 99.");
      expect(rows[100]?.derivedTitle).toBeUndefined();
    },
  );
});
