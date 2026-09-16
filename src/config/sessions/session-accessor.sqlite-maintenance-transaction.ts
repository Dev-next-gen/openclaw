import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import {
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  partitionUnchangedPlannedLifecycleArtifactEntries,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SqliteSessionReclamationCallbacks,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenanceInDatabase,
  readNextSessionEntryMaintenanceAtInDatabase,
  refreshSessionPlannerStatisticsInDatabase,
} from "./session-accessor.sqlite-maintenance-store.js";

type MaintenancePlan = Extract<
  SqliteSessionReclamationPlan,
  {
    kind:
      | "maintenance-plan"
      | "maintenance-finalize"
      | "maintenance-schedule"
      | "maintenance-statistics";
  }
>;

export function reclaimSessionMaintenanceInTransaction(
  plan: MaintenancePlan,
  callbacks: SqliteSessionReclamationCallbacks,
): SqliteSessionReclamationResult {
  if (plan.kind === "maintenance-schedule") {
    const value = runOpenClawAgentWriteTransaction((database) => {
      callbacks.beforeMutation?.();
      return readNextSessionEntryMaintenanceAtInDatabase(database, plan.maintenance);
    }, plan.databaseOptions);
    return { kind: plan.kind, value };
  }
  if (plan.kind === "maintenance-statistics") {
    const database = openOpenClawAgentDatabase(plan.databaseOptions);
    runWithSqliteBusyTimeout(database.db, 0, () =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          callbacks.beforeMutation?.();
          refreshSessionPlannerStatisticsInDatabase(current);
          callbacks.onCommit?.(current);
        },
        plan.databaseOptions,
        { busyTimeoutMs: 0 },
      ),
    );
    return { kind: plan.kind, value: true };
  }
  if (plan.kind === "maintenance-plan") {
    let preservationRequired: Error | undefined;
    try {
      const value = runOpenClawAgentWriteTransaction((database) => {
        callbacks.beforeMutation?.();
        const maintenance = applySessionEntryMaintenanceInDatabase(database, plan.input, () => {
          if (plan.input.preservation === null) {
            preservationRequired = new Error("SQLite maintenance requires session preservation");
            throw preservationRequired;
          }
          return plan.input.preservation;
        });
        if (maintenance.archived > 0 || maintenance.entryRemovals.length > 0) {
          callbacks.onCommit?.(database);
        }
        return maintenance;
      }, plan.databaseOptions);
      return { kind: plan.kind, value };
    } catch (error) {
      if (preservationRequired && error === preservationRequired) {
        // Candidate discovery requested protection before writes; the transaction has rolled back.
        return { kind: "maintenance-preservation-required" };
      }
      throw error;
    }
  }

  return runSqliteSessionDeletionTransaction((database) => {
    callbacks.beforeMutation?.();
    const partition = partitionUnchangedPlannedLifecycleArtifactEntries(database, plan.entries);
    const archivedTranscripts = deleteMaterializedSessionStatePlans(
      database,
      plan.materializedPlans,
      undefined,
      new Set(partition.unchanged.map((entry) => entry.sessionKey)),
    );
    deletePlannedLifecycleArtifactEntries(database, partition.unchanged);
    const result: Extract<SqliteSessionReclamationResult, { kind: "maintenance-finalize" }> = {
      kind: plan.kind,
      value: {
        archivedTranscripts,
        changedEntries: partition.changed,
        committedEntries: partition.unchanged,
      },
    };
    callbacks.onCommit?.(database, result);
    return result;
  }, plan.databaseOptions);
}
