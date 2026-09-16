import { readBoardSessionKeys } from "../../boards/sqlite-board-store.kernel.js";
import type { GatewayStoredSessionTarget } from "../../config/sessions/combined-store-gateway.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { projectSessionActivitySummary } from "../session-activity-summary-state.js";
import { isSessionPermissionChangePending } from "../session-permission-change.js";
import type { WorkerPlacementMoveIntent } from "../worker-environments/placement-move-intent.js";
import {
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/session-placement-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

export type SessionPlacementReadContext = Pick<
  GatewayRequestContext,
  | "workerSessionPlacementService"
  | "workerPlacementDiskSpaceReader"
  | "workerPlacementRunnerAvailabilityReader"
> & {
  workerEnvironmentService?: Parameters<typeof readWorkerPlacementIdentity>[1];
};

function prepareSessionPlacementFields(
  context: SessionPlacementReadContext,
  placement: WorkerSessionPlacementRecord | undefined,
  move: WorkerPlacementMoveIntent | undefined,
  workspaceResultReconciling: boolean,
) {
  const environment = placement?.environmentId
    ? context.workerEnvironmentService?.get(placement.environmentId)
    : undefined;
  const identity = placement
    ? readWorkerPlacementIdentity(placement, context.workerEnvironmentService)
    : undefined;
  const failedRecoveryAction =
    placement?.state === "failed"
      ? isFailedWorkerPlacementEnvironmentGone({
          environmentService: context.workerEnvironmentService,
          placement,
        })
        ? "restart"
        : "stop-first"
      : undefined;
  return () => ({
    ...(placement
      ? {
          placement: projectWorkerSessionPlacement(
            placement,
            context.workerPlacementDiskSpaceReader?.read(placement),
            context.workerPlacementRunnerAvailabilityReader?.read(placement, environment ?? null),
            identity,
            failedRecoveryAction,
            workspaceResultReconciling,
          ),
        }
      : {}),
    ...(move ? { placementMove: projectWorkerPlacementMove(move) } : {}),
  });
}

export function createSessionPlacementBatchProjector(
  context: SessionPlacementReadContext,
  sessions: readonly { sessionId?: string }[],
) {
  const sessionIds = sessions.flatMap((session) => (session.sessionId ? [session.sessionId] : []));
  const placements = context.workerSessionPlacementService?.getMany(sessionIds);
  const workspaceResultReconcilingSessionIds =
    context.workerSessionPlacementService?.getWorkspaceResultReconcilingSessionIds?.(sessionIds);
  const moves = context.workerSessionPlacementService?.getPlacementMoves?.(sessionIds);
  const prepared = new Map(
    sessionIds.map((sessionId) => [
      sessionId,
      prepareSessionPlacementFields(
        context,
        placements?.get(sessionId),
        moves?.get(sessionId),
        workspaceResultReconcilingSessionIds?.has(sessionId) ?? false,
      ),
    ]),
  );
  return (sessionId: string | undefined) => prepared.get(sessionId ?? "")?.() ?? {};
}

export function readSessionPlacementFields(
  context: SessionPlacementReadContext,
  sessionId: string | undefined,
) {
  return createSessionPlacementBatchProjector(
    context,
    sessionId ? [{ sessionId }] : [{}],
  )(sessionId);
}

/** Acquire cold facts only for this dirty physical row; presentation reads live memory. */
export function readSessionRowFacts(params: {
  cfg: OpenClawConfig;
  target: Pick<GatewayStoredSessionTarget, "agentId" | "storeTarget"> & { key: string };
  entry: SessionEntry;
  context?: SessionPlacementReadContext;
}) {
  const { cfg, target, entry } = params;
  const placement = createSessionPlacementBatchProjector(params.context ?? {}, [entry]);
  const activitySummary = projectSessionActivitySummary({ ...target, cfg, entry });
  const board = withOpenClawAgentDatabaseReadOnly(
    (database) => readBoardSessionKeys(database, target.key).length > 0,
    { agentId: target.storeTarget.agentId, path: target.storeTarget.storePath },
  );
  return {
    hasBoard: board.found && board.value,
    present: () => ({
      ...placement(entry.sessionId),
      permissionModePending: isSessionPermissionChangePending(entry.sessionId),
      activitySummary: activitySummary ? { ...activitySummary } : undefined,
    }),
  };
}
