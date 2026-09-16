import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  isSqliteWorkerStoreAvailable,
  openSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  SqliteWorkerError,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-store.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import {
  createOpenClawAgentDatabaseClaim,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "../../state/openclaw-agent-db-readonly-open.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { getOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionListWorkerOperations } from "./session-accessor.sqlite-list-worker-contract.js";

type Store = SqliteWorkerStore<SessionListWorkerOperations>;
type ReadBackend = {
  activeReads: number;
  failed: boolean;
  opening: Promise<Store | undefined>;
  closing?: Promise<void>;
};
type ReadResource = {
  identity: string | symbol;
  revoked: boolean;
  observer?: OpenClawAgentReadOnlyDatabaseHandle;
  backend?: ReadBackend;
  close: () => Promise<void>;
};
const resources = new Map<string, ReadResource>();
// Keep more actors than the four worker slots, without occupying the broker's 64 clients.
const MAX_IDLE_BACKENDS = 8;
const idleBackends = new Map<ReadBackend, ReadResource>();

function readTotalChanges(database: OpenClawAgentReadOnlyDatabase["db"]): number {
  const query = getNodeSqliteKysely(database).selectNoFrom(({ fn }) =>
    fn<number>("total_changes", []).as("changes"),
  );
  const changes = executeSqliteQueryTakeFirstSync(database, query)?.changes;
  if (typeof changes !== "number") {
    throw new Error("SQLite did not return a numeric total_changes() value");
  }
  return changes;
}

function closeReadBackend(resource: ReadResource, backend = resource.backend): Promise<void> {
  if (!backend) {
    return Promise.resolve();
  }
  idleBackends.delete(backend);
  backend.closing ??= backend.opening
    .then(
      (store) => store?.close(),
      () => undefined,
    )
    .then(() => {
      if (resource.backend === backend) {
        resource.backend = undefined;
      }
    })
    .catch((error: unknown) => {
      backend.closing = undefined;
      throw error;
    });
  return backend.closing;
}

async function releaseOldestIdleBackend(): Promise<boolean> {
  const oldest = idleBackends.entries().next();
  if (oldest.done) {
    return false;
  }
  const [backend, resource] = oldest.value;
  await closeReadBackend(resource, backend);
  return true;
}

async function openReadBackend(
  resource: ReadResource,
  database: OpenClawAgentReadOnlyDatabase,
  identity: string,
): Promise<Store | undefined> {
  const open = () => {
    if (resource.revoked) {
      throw new Error("Session metadata worker read was revoked");
    }
    return openSqliteWorkerStore<SessionListWorkerOperations>({
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionMetadata),
      databasePath: database.path,
      existingOnly: true,
      input: { agentId: database.agentId, identity },
    });
  };
  try {
    return await open();
  } catch (error) {
    if (
      error instanceof SqliteWorkerError &&
      error.code === "overloaded" &&
      (await releaseOldestIdleBackend())
    ) {
      // Release only our idle custody, then make one fresh broker admission attempt.
      return await open();
    }
    throw error;
  }
}

function createReadResource(
  key: string,
  database: OpenClawAgentReadOnlyDatabase,
  observer?: OpenClawAgentReadOnlyDatabaseHandle,
): ReadResource {
  let unregister = () => {};
  let closing: Promise<void> | undefined;
  const owner: ReadResource = {
    identity: readOpenClawAgentDatabaseIdentity(database).identity,
    revoked: false,
    observer,
    close: () => {
      owner.revoked = true;
      if (!closing) {
        closing = closeReadBackend(owner)
          .then(() => {
            owner.observer?.close();
            owner.observer = undefined;
            unregister();
            if (resources.get(key) === owner) {
              resources.delete(key);
            }
          })
          .catch((error: unknown) => {
            closing = undefined;
            throw error;
          });
      }
      return closing;
    },
  };
  unregister = registerOpenClawAgentDatabaseAsyncResource({
    agentId: database.agentId,
    path: database.path,
    revoke: () => {
      owner.revoked = true;
    },
    close: owner.close,
  });
  resources.set(key, owner);
  return owner;
}

export type SessionListDatabaseRead = {
  database: OpenClawAgentReadOnlyDatabase;
  assertCurrent: () => void;
  captureReadValidity: () => () => boolean;
  execute: Store["execute"];
};

/** Final page checks may reuse an admitted observer, but never open or scan a cold store. */
export function readSessionListDatabaseCurrent<T>(
  options: OpenClawAgentDatabaseOptions,
  read: (database: OpenClawAgentReadOnlyDatabase) => T,
): T {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  const resource = resources.get(JSON.stringify([agentId, pathname]));
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  let host;
  try {
    host = getOpenClawAgentDatabaseIfOpen({ ...options, agentId });
  } catch {
    // A retained read-only observer remains independent of writable admission failures.
  }
  const database = host && !host.db.isTransaction ? host : resource?.observer;
  if (
    !resource ||
    resource.revoked ||
    !database ||
    resource.identity !== readOpenClawAgentDatabaseIdentity(database).identity ||
    !isOpenClawAgentDatabasePathCurrent(database) ||
    !hasOpenClawAgentReadOnlySchema(database)
  ) {
    throw new Error("Session page observer is no longer admitted");
  }
  return read(database);
}

type AdmittedRead = {
  resource: ReadResource;
  database: OpenClawAgentReadOnlyDatabase;
  claim: ReturnType<typeof createOpenClawAgentDatabaseClaim>;
};

async function admitSessionListRead(
  options: OpenClawAgentDatabaseOptions,
  mayRetire = true,
): Promise<AdmittedRead | undefined> {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const key = JSON.stringify([agentId, pathname]);
  const resource = resources.get(key);
  const retire = async () => {
    if (!resource || !mayRetire) {
      throw new Error("Session metadata database changed during read admission");
    }
    await resource.close();
    // Another waiter may already have installed the replacement resource.
    return admitSessionListRead(options, false);
  };
  if (
    resource?.revoked ||
    (resource?.observer && !isOpenClawAgentDatabasePathCurrent(resource.observer))
  ) {
    return retire();
  }
  let host;
  try {
    host = getOpenClawAgentDatabaseIfOpen({ ...options, agentId });
  } catch {
    // Read-only admission does not inherit the writable owner's latched failures.
  }
  const retained =
    host && !host.db.isTransaction
      ? retainOpenClawAgentDatabaseReadOnly({ ...options, agentId })
      : undefined;
  let observer = resource?.observer;
  if (!retained?.found && !observer) {
    const opened = openOpenClawAgentDatabaseReadOnly({ ...options, agentId });
    if (!opened.found) {
      return undefined;
    }
    observer = opened.database;
  }
  const database = retained?.found ? retained.database : observer;
  if (!database) {
    return undefined;
  }
  const claim = retained?.found
    ? retained.claim
    : createOpenClawAgentDatabaseClaim(database, () => {});
  if (resource && resource.identity !== readOpenClawAgentDatabaseIdentity(database).identity) {
    claim.release();
    if (observer && observer !== resource.observer) {
      observer.close();
    }
    return retire();
  }
  try {
    if (!isOpenClawAgentDatabasePathCurrent(database)) {
      throw new Error("Session metadata read physical database changed");
    }
    const owned = resource ?? createReadResource(key, database, observer);
    owned.observer ??= observer;
    return { resource: owned, database, claim };
  } catch (error) {
    claim.release();
    if (observer && observer !== resource?.observer) {
      observer.close();
    }
    throw error;
  }
}

/** Cold observers and worker actors belong to the registered read lifecycle, not one request. */
export async function withSessionListDatabaseRead<T>(
  options: OpenClawAgentDatabaseOptions,
  read: (owner: SessionListDatabaseRead) => T | Promise<T>,
): Promise<T | undefined> {
  const admitted = await admitSessionListRead(options);
  if (!admitted) {
    return undefined;
  }
  const { resource: owned, database, claim } = admitted;
  const agentId = database.agentId;
  try {
    const identity = readOpenClawAgentDatabaseIdentity(database);
    const validation = getOpenClawAgentDatabaseValidation(database);
    const assertObserverCurrent = () => {
      assertAgentDatabaseAdmitted(agentId, { env: options.env });
      if (
        owned.revoked ||
        !isOpenClawAgentDatabasePathCurrent(database) ||
        readOpenClawAgentDatabaseIdentity(database).incarnation !== identity.incarnation ||
        getOpenClawAgentDatabaseValidation(database) !== validation ||
        !hasOpenClawAgentReadOnlySchema(database)
      ) {
        throw new Error("Session metadata read lost its database admission");
      }
    };
    const assertCurrent = () => {
      claim.assertCurrent();
      assertObserverCurrent();
    };
    const captureReadValidity = () => {
      assertCurrent();
      const dataVersion = readSqliteDataVersion(database.db);
      const totalChanges = readTotalChanges(database.db);
      return () => {
        try {
          // The resource retains the observer after this request's claim is released.
          assertObserverCurrent();
          return (
            readSqliteDataVersion(database.db) === dataVersion &&
            readTotalChanges(database.db) === totalChanges
          );
        } catch {
          return false;
        }
      };
    };
    const execute = async <Key extends keyof SessionListWorkerOperations>(
      command: { type: Key; input: SessionListWorkerOperations[Key]["input"] },
      executeOptions?: { signal?: AbortSignal },
    ): Promise<SessionListWorkerOperations[Key]["output"]> => {
      assertCurrent();
      if (typeof identity.identity !== "string") {
        throw new Error("Session metadata workers require a durable database");
      }
      if (owned.backend?.closing) {
        await owned.backend.closing;
        assertCurrent();
      }
      let backend = owned.backend;
      if (!backend) {
        const created: ReadBackend = {
          activeReads: 0,
          failed: false,
          opening: Promise.resolve(undefined),
        };
        owned.backend = created;
        created.opening = openReadBackend(owned, database, identity.identity).catch(
          (error: unknown) => {
            created.failed = true;
            throw error;
          },
        );
        backend = created;
      }
      idleBackends.delete(backend);
      backend.activeReads++;
      try {
        const store = await backend.opening;
        assertCurrent();
        if (!store || !isSqliteWorkerStoreAvailable(store)) {
          backend.failed = true;
          throw new Error("Session metadata worker is unavailable");
        }
        const value = await runSqliteWorkerStoreOperation<
          SessionListWorkerOperations,
          SessionListWorkerOperations[Key]["output"]
        >(
          store,
          (operation) => operation.execute(command, executeOptions),
          undefined,
          assertCurrent,
        );
        assertCurrent();
        return value;
      } finally {
        backend.activeReads--;
        if (backend.activeReads === 0 && owned.backend === backend && !owned.revoked) {
          if (backend.failed) {
            await closeReadBackend(owned, backend);
          } else if (!backend.closing) {
            idleBackends.set(backend, owned);
            const excess = idleBackends.size - MAX_IDLE_BACKENDS;
            for (let index = 0; index < excess; index++) {
              if (!(await releaseOldestIdleBackend())) {
                break;
              }
            }
          }
        }
      }
    };
    assertCurrent();
    const result = await read({ database, assertCurrent, captureReadValidity, execute });
    assertCurrent();
    return result;
  } finally {
    claim.release();
  }
}
