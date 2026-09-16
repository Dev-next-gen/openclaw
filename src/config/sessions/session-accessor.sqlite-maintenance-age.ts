import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionEntryRevision } from "./session-accessor.sqlite-entry-revision.js";
import { readSessionMaintenanceAgeQueries } from "./session-accessor.sqlite-maintenance-age-queries.js";
import { hasCanonicalSessionValidationProjection } from "./session-canonical-key.js";
import {
  getSessionMaintenanceActivityAt,
  shouldPreserveMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type AgeFact = {
  token: SqliteSessionEntryRevision;
  oldestUpdatedAt: number;
  oldestDashboardActivityAt: number;
  next?: { policy: string; at: number };
};
type Activity = Parameters<typeof getSessionMaintenanceActivityAt>[0];
type ActivityRow = {
  updated_at: number;
  last_activity_at: number | null;
  last_interaction_at: number | null;
  session_started_at: number | null;
};

// Share the entry cache's raw-DML/external-commit revision, not its listing snapshot.
const ageFacts = new WeakMap<DatabaseSync, AgeFact>();

function stageAgeFact(db: DatabaseSync, fact: AgeFact): void {
  if (
    stageSqliteTransactionState(db, {
      stage: () => ageFacts.set(db, fact),
      rollback: () => ageFacts.delete(db),
      commit: () => {},
    })
  ) {
    return;
  }
  if (!db.isTransaction) {
    ageFacts.set(db, fact);
  }
}

export function hasSessionEntryMaintenanceAgeFact(db: DatabaseSync): boolean {
  return ageFacts.has(db);
}

export function readSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  token: SqliteSessionEntryRevision,
): AgeFact | undefined {
  const fact = ageFacts.get(db);
  if (
    fact?.token.dataVersion !== token.dataVersion ||
    fact.token.sessionNodesGeneration !== token.sessionNodesGeneration
  ) {
    ageFacts.delete(db);
    return undefined;
  }
  return fact;
}

function isDashboardKey(key: string): boolean {
  return parseAgentSessionKey(key)?.rest.startsWith("dashboard:") === true;
}

function includeEntryAge(fact: AgeFact, key: string, entry: Activity): void {
  // Only key-inherent protection is stable without rereading live admissions or row fields.
  if (shouldPreserveMaintenanceEntry({ key, entry: undefined })) {
    return;
  }
  fact.oldestUpdatedAt = Math.min(fact.oldestUpdatedAt, entry?.updatedAt ?? Infinity);
  if (isDashboardKey(key)) {
    fact.oldestDashboardActivityAt = Math.min(
      fact.oldestDashboardActivityAt,
      getSessionMaintenanceActivityAt(entry),
    );
  }
}

/** Tracked writes can only bring the conservative age boundary forward. */
export function advanceSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  generation: { before: number; after: number },
  update?: { sessionKey: string; entry: SessionEntry; previousEntry?: SessionEntry },
): void {
  const fact = ageFacts.get(db);
  if (!fact) {
    return;
  }
  if (!update || fact.token.sessionNodesGeneration !== generation.before) {
    ageFacts.delete(db);
    return;
  }
  const { entry, previousEntry } = update;
  const older =
    !previousEntry ||
    (previousEntry.archivedAt !== undefined && entry.archivedAt === undefined) ||
    entry.updatedAt < previousEntry.updatedAt ||
    getSessionMaintenanceActivityAt(entry) < getSessionMaintenanceActivityAt(previousEntry);
  const next: AgeFact = {
    ...fact,
    token: { ...fact.token, sessionNodesGeneration: generation.after },
    next: older ? undefined : fact.next,
  };
  if (entry.archivedAt === undefined) {
    includeEntryAge(next, update.sessionKey, entry);
  }
  stageAgeFact(db, next);
}

function agePolicy(maintenance: ResolvedSessionMaintenanceConfig): string {
  return JSON.stringify([
    maintenance.pruneAfterMs,
    maintenance.archiveDashboardAfterMs,
    maintenance.preserveRecentMs,
  ]);
}

function nextAgeAt(timestamp: number, age: number | null | undefined, now: number): number {
  const at = age != null && age > 0 ? timestamp + age + 1 : Infinity;
  return at > now ? at : Infinity;
}

function readActivityAt(row: ActivityRow): number {
  return getSessionMaintenanceActivityAt({
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? undefined,
    lastInteractionAt: row.last_interaction_at ?? undefined,
    sessionStartedAt: row.session_started_at ?? undefined,
  });
}

/** The caller's transaction keeps these indexed probes in one snapshot. */
export function recordSessionEntryMaintenanceAgeFact(
  database: OpenClawAgentDatabase,
  token: SqliteSessionEntryRevision,
  maintenance: ResolvedSessionMaintenanceConfig,
): void {
  const next = { policy: agePolicy(maintenance), at: Infinity };
  const fact: AgeFact = {
    token,
    oldestUpdatedAt: Infinity,
    oldestDashboardActivityAt: Infinity,
    next,
  };
  const now = Date.now();
  const queries = readSessionMaintenanceAgeQueries(database.db);
  for (const row of queries.oldest(undefined)) {
    if (!shouldPreserveMaintenanceEntry({ key: row.session_key, entry: undefined })) {
      fact.oldestUpdatedAt = row.updated_at;
      break;
    }
  }
  next.at = nextAgeAt(fact.oldestUpdatedAt, maintenance.pruneAfterMs, now);
  if (maintenance.pruneAfterMs > 0 && fact.oldestUpdatedAt + maintenance.pruneAfterMs + 1 <= now) {
    for (const row of queries.after(now - maintenance.pruneAfterMs - 1)) {
      if (!shouldPreserveMaintenanceEntry({ key: row.session_key, entry: undefined })) {
        next.at = nextAgeAt(row.updated_at, maintenance.pruneAfterMs, now);
        break;
      }
    }
  }
  // Certified keys support indexed namespaces; pending aliases retain the canonical decoder.
  // Older maintenance readers have no pending projection and keep their full row path.
  const dashboardRows = hasCanonicalSessionValidationProjection(database)
    ? [queries.dashboards(undefined), queries.uncertified(undefined)]
    : [queries.activity(undefined)];
  for (const rows of dashboardRows) {
    for (const row of rows) {
      if (
        !isDashboardKey(row.session_key) ||
        shouldPreserveMaintenanceEntry({ key: row.session_key, entry: undefined })
      ) {
        continue;
      }
      const activity = readActivityAt(row);
      fact.oldestDashboardActivityAt = Math.min(fact.oldestDashboardActivityAt, activity);
      next.at = Math.min(next.at, nextAgeAt(activity, maintenance.archiveDashboardAfterMs, now));
    }
  }
  const recentAge = maintenance.preserveRecentMs;
  if (recentAge != null && recentAge > 0) {
    for (const row of queries.activity(undefined)) {
      // Activity includes updatedAt, so later indexed rows cannot improve this finite bound.
      if (row.updated_at + recentAge + 1 >= next.at) {
        break;
      }
      if (!shouldPreserveMaintenanceEntry({ key: row.session_key, entry: undefined })) {
        next.at = Math.min(next.at, nextAgeAt(readActivityAt(row), recentAge, now));
      }
    }
  }
  stageAgeFact(database.db, fact);
}

/** Infinity leaves the kick's periodic recheck in charge of released live protection. */
export function readSessionEntryMaintenanceNextAgeAt(
  database: OpenClawAgentDatabase,
  token: SqliteSessionEntryRevision,
  maintenance: ResolvedSessionMaintenanceConfig,
): number | undefined {
  if (maintenance.mode !== "enforce") {
    return undefined;
  }
  const fact = readSessionEntryMaintenanceAgeFact(database.db, token);
  if (fact?.next?.policy === agePolicy(maintenance) && fact.next.at > Date.now()) {
    return fact.next.at;
  }
  recordSessionEntryMaintenanceAgeFact(database, token, maintenance);
  return ageFacts.get(database.db)?.next?.at;
}
