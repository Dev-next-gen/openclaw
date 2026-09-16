import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { isBunRuntime } from "../../daemon/runtime-binary.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  readCachedExactSessionEntries,
  readSessionEntryCacheAsync,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  iterateSessionEntriesForListing,
  listSessionEntriesReadOnly,
} from "./session-accessor.sqlite-entry.js";
import {
  groupExactSessionEntryReadRequests,
  readExactSessionEntryCandidatesInDatabase,
  type ExactSessionEntryBatchScope,
} from "./session-accessor.sqlite-exact-read.js";
import {
  decodeSessionListWorkerError,
  type SessionListPageRead,
} from "./session-accessor.sqlite-list-worker-contract.js";
import {
  readSessionListDatabaseCurrent,
  withSessionListDatabaseRead,
} from "./session-accessor.sqlite-list-worker-runtime.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope, SessionEntrySummary } from "./session-accessor.types.js";
import {
  adoptCanonicalSessionReadAdmission,
  assertCanonicalSqliteSessionKeysCurrent,
  readCanonicalSessionMainKey,
} from "./session-canonical-key.js";
import { withCanonicalSessionValidationDeferral } from "./session-canonical-validation-deferral.js";
import { listSessionMembershipKeysInDatabase } from "./session-sharing-store.js";

export async function listSessionEntriesReadOnlyAsync(
  scope: SessionEntryListScope = {},
): Promise<SessionEntrySummary[]> {
  const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" }));
  if (
    isBunRuntime(process.execPath) ||
    scope.projection !== "list" ||
    scope.readConsistency === "latest" ||
    isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options)
  ) {
    return listSessionEntriesReadOnly(scope);
  }
  const result = await withSessionListDatabaseRead(options, async (owner) => {
    const snapshot = await readSessionEntryCacheAsync(owner.database, {
      assertCurrent: owner.assertCurrent,
      load: async (validateCanonical, mainKey) => {
        const loaded = await owner.execute({
          type: "inventory",
          input: { validateCanonical, mainKey },
        });
        if (!loaded.ok) {
          throw decodeSessionListWorkerError(loaded.error);
        }
        return (
          loaded.value ?? {
            entries: new Map(),
            keys: [],
            mainKey: readCanonicalSessionMainKey(owner.database),
          }
        );
      },
    });
    owner.assertCurrent();
    return Array.from(
      iterateSessionEntriesForListing(
        snapshot,
        scope.clone !== false,
        scope.sessionKeys ? new Set(scope.sessionKeys) : undefined,
      ),
    );
  });
  return result ?? [];
}

/** The page read starts after inventory projection; it never borrows inventory-era membership. */
export async function readSessionListPageReadOnlyAsync(
  scopes: readonly ExactSessionEntryBatchScope[],
  options: {
    membershipIdentityId?: string;
    onReadAdmission?: (isCurrent: () => boolean) => void;
  } = {},
): Promise<Array<Result<SessionListPageRead, unknown>>> {
  if (isBunRuntime(process.execPath)) {
    // Its synchronous readers close on return, so final consumers must reread after a yield.
    options.onReadAdmission?.(() => false);
    return readSessionListPageSynchronously(scopes, options);
  }
  const grouped = groupExactSessionEntryReadRequests(scopes);
  const results = grouped.results.map((result): Result<SessionListPageRead, unknown> =>
    result.ok ? ok({ entries: result.value, membershipKeys: [] }) : err(result.error),
  );
  for (const group of grouped.groups.values()) {
    try {
      const values = await withSessionListDatabaseRead(group.options, async (owner) => {
        const requests = group.requests.map((request) => request.sessionKeys);
        const keys = [...new Set(requests.flat())];
        const identityId = options.membershipIdentityId?.trim();
        const admission = withCanonicalSessionValidationDeferral(() =>
          assertCanonicalSqliteSessionKeysCurrent(owner.database),
        );
        options.onReadAdmission?.(owner.captureReadValidity());
        const cached =
          admission.kind === "complete"
            ? readCachedExactSessionEntries(owner.database, keys)
            : undefined;
        if (cached || isIncognitoOpenClawAgentSqlitePath(owner.database.path, group.options)) {
          const entries = cached
            ? requests.map((requested) =>
                ok(
                  requested.flatMap((sessionKey) => {
                    const entry = cached.get(sessionKey);
                    return entry ? [{ sessionKey, entry }] : [];
                  }),
                ),
              )
            : readExactSessionEntryCandidatesInDatabase(owner.database, requests, "list");
          const memberships = identityId
            ? listSessionMembershipKeysInDatabase(owner.database, keys, identityId)
            : new Set<string>();
          return entries.map((result): Result<SessionListPageRead, unknown> =>
            result.ok
              ? ok({
                  entries: result.value,
                  membershipKeys: result.value.flatMap(({ sessionKey }) =>
                    memberships.has(sessionKey) ? [sessionKey] : [],
                  ),
                })
              : result,
          );
        }
        const selected = await owner.execute({
          type: "selected",
          input: {
            requests,
            validateCanonical: admission.kind === "pending",
            mainKey: readCanonicalSessionMainKey(owner.database),
            membershipIdentityId: identityId,
          },
        });
        if (!selected.ok) {
          throw decodeSessionListWorkerError(selected.error);
        }
        if (
          selected.value &&
          !adoptCanonicalSessionReadAdmission(owner.database, selected.value.mainKey)
        ) {
          throw new Error("Session page canonical policy changed during the read");
        }
        return selected.value?.results.map((result): Result<SessionListPageRead, unknown> =>
          result.ok ? result : err(decodeSessionListWorkerError(result.error)),
        );
      });
      for (const [ordinal, request] of group.requests.entries()) {
        const result: Result<SessionListPageRead, unknown> =
          values?.[ordinal] ?? ok({ entries: [], membershipKeys: [] });
        results[request.index] = result;
        if (result.ok) {
          scopes[request.index]!.onReadSource?.({
            agentId: group.options.agentId!,
            path: resolveOpenClawAgentSqlitePath(group.options),
          });
        }
      }
    } catch (error) {
      for (const request of group.requests) {
        results[request.index] = err(error);
      }
    }
  }
  return results;
}

/** Refresh only selected facts at the final synchronous access boundary. */
export function readSessionListPageReadOnlyCurrent(
  scopes: readonly ExactSessionEntryBatchScope[],
  options: { membershipIdentityId?: string } = {},
): Array<Result<SessionListPageRead, unknown>> {
  if (isBunRuntime(process.execPath)) {
    return readSessionListPageSynchronously(scopes, options);
  }
  const grouped = groupExactSessionEntryReadRequests(scopes);
  const results = grouped.results.map((result): Result<SessionListPageRead, unknown> =>
    result.ok ? ok({ entries: result.value, membershipKeys: [] }) : err(result.error),
  );
  for (const group of grouped.groups.values()) {
    try {
      const values = readSessionListDatabaseCurrent(group.options, (database) => {
        const admission = withCanonicalSessionValidationDeferral(() =>
          assertCanonicalSqliteSessionKeysCurrent(database),
        );
        if (admission.kind !== "complete") {
          throw new Error("Session page canonical admission changed after preparation");
        }
        const requests = group.requests.map((request) => request.sessionKeys);
        const entries = readExactSessionEntryCandidatesInDatabase(database, requests, "list");
        const identityId = options.membershipIdentityId?.trim();
        const memberships = identityId
          ? listSessionMembershipKeysInDatabase(database, [...new Set(requests.flat())], identityId)
          : new Set<string>();
        return entries.map((result): Result<SessionListPageRead, unknown> =>
          result.ok
            ? ok({
                entries: result.value,
                membershipKeys: result.value.flatMap(({ sessionKey }) =>
                  memberships.has(sessionKey) ? [sessionKey] : [],
                ),
              })
            : err(result.error),
        );
      });
      for (const [ordinal, request] of group.requests.entries()) {
        results[request.index] = values[ordinal]!;
      }
    } catch (error) {
      for (const request of group.requests) {
        results[request.index] = err(error);
      }
    }
  }
  return results;
}

// Bun's existing native readers retain their established lifetime until native statement
// retirement can support a persistent host observer. This is runtime selection, not retry.
function readSessionListPageSynchronously(
  scopes: readonly ExactSessionEntryBatchScope[],
  options: { membershipIdentityId?: string },
): Array<Result<SessionListPageRead, unknown>> {
  const grouped = groupExactSessionEntryReadRequests(scopes);
  const results = grouped.results.map((result): Result<SessionListPageRead, unknown> =>
    result.ok ? ok({ entries: result.value, membershipKeys: [] }) : err(result.error),
  );
  for (const group of grouped.groups.values()) {
    try {
      const read = withOpenClawAgentDatabaseReadOnly((database) => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const requests = group.requests.map((request) => request.sessionKeys);
        const entries = readExactSessionEntryCandidatesInDatabase(database, requests, "list");
        const identityId = options.membershipIdentityId?.trim();
        const memberships = identityId
          ? listSessionMembershipKeysInDatabase(database, [...new Set(requests.flat())], identityId)
          : new Set<string>();
        return entries.map((result): Result<SessionListPageRead, unknown> =>
          result.ok
            ? ok({
                entries: result.value,
                membershipKeys: result.value.flatMap(({ sessionKey }) =>
                  memberships.has(sessionKey) ? [sessionKey] : [],
                ),
              })
            : err(result.error),
        );
      }, group.options);
      for (const [ordinal, request] of group.requests.entries()) {
        results[request.index] = read.found
          ? read.value[ordinal]!
          : ok({ entries: [], membershipKeys: [] });
      }
    } catch (error) {
      for (const request of group.requests) {
        results[request.index] = err(error);
      }
    }
  }
  return results;
}
