export type SessionListPhase =
  | "setup"
  | "modelCatalog"
  | "storeLoad"
  | "filterSetup"
  | "rows"
  | "sharing"
  | "decoration"
  | "visibilityRepair"
  | "response"
  | "handlerExit";

type SessionListProjectionTiming = {
  prepareSyncMs: number;
  rowSyncMs: number;
  yieldWaitMs: number;
  yieldCount: number;
};

export type SessionListDiagnostics = {
  mark: (phase: SessionListPhase) => void;
  projection: SessionListProjectionTiming & {
    selectedRowCount: number;
    dirtyRowCount: number;
    materializedRowCount: number;
    reusedRowCount: number;
  };
};
