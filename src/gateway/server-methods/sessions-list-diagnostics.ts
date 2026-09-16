import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import type { SessionListProjectionTiming } from "../session-utils-list.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

type Phase =
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
const sessionListDiagnostics = channel("openclaw.session.list");

export type SessionListDiagnostics = NonNullable<ReturnType<typeof startSessionListDiagnostics>>;

function startSessionListDiagnostics(
  respond: RespondFn,
  operation: "sessions.list" | "sessions.subscribe",
) {
  const logEnabled = areDiagnosticsEnabledForProcess() && sessionLog.isEnabled("warn");
  if (!logEnabled && !sessionListDiagnostics.hasSubscribers) {
    return undefined;
  }
  let checkpoint = performance.now();
  const startedAt = checkpoint;
  const timing = createStageTimingTracker(() => checkpoint);
  const trace = getActiveDiagnosticTraceContext();
  let phase: Phase = "setup";
  const projection: SessionListProjectionTiming & {
    selectedRowCount: number;
    dirtyRowCount: number;
    materializedRowCount: number;
    reusedRowCount: number;
  } = {
    prepareSyncMs: 0,
    rowSyncMs: 0,
    yieldWaitMs: 0,
    yieldCount: 0,
    selectedRowCount: 0,
    dirtyRowCount: 0,
    materializedRowCount: 0,
    reusedRowCount: 0,
  };
  let responseOutcome: "none" | "ok" | "error" | "threw" = "none";
  const mark = (next: Phase) => {
    checkpoint = performance.now();
    timing.mark(phase);
    phase = next;
  };
  return {
    trace,
    mark,
    get projection() {
      return projection;
    },
    respond: ((...args) => {
      mark("response");
      responseOutcome = args[0] ? "ok" : "error";
      try {
        return respond(...args);
      } catch (error) {
        responseOutcome = "threw";
        throw error;
      } finally {
        mark("handlerExit");
      }
    }) satisfies RespondFn,
    finish(handlerOutcome: "returned" | "threw") {
      mark("handlerExit");
      const handlerElapsedMs = checkpoint - startedAt;
      const shouldLog =
        logEnabled && handlerElapsedMs >= 1_000 && areDiagnosticsEnabledForProcess();
      if (!shouldLog && !sessionListDiagnostics.hasSubscribers) {
        return;
      }
      try {
        // Repair repeats phases; sum them without retaining row or yield records.
        const phaseDurationsMs: Record<string, number> = {};
        for (const stage of timing.snapshot().stages) {
          phaseDurationsMs[stage.name] = (phaseDurationsMs[stage.name] ?? 0) + stage.durationMs;
        }
        const fields = {
          operation,
          pid: process.pid,
          threadId,
          isMainThread,
          handlerElapsedMs: Math.round(handlerElapsedMs),
          phaseDurationsMs,
          ...(projection
            ? Object.fromEntries(
                Object.entries(projection).map(([key, value]) => [key, Math.round(value)]),
              )
            : {}),
          handlerOutcome,
          responseOutcome,
        };
        if (sessionListDiagnostics.hasSubscribers) {
          sessionListDiagnostics.publish(fields);
        }
        if (shouldLog) {
          runWithDiagnosticTraceContext(trace, () =>
            sessionLog.warn("slow session list", {
              ...fields,
            }),
          );
        }
      } catch {
        // Diagnostic sinks cannot replace the response or original exception.
      }
    },
  };
}

export function withSessionListDiagnostics(
  handler: (
    args: GatewayRequestHandlerOptions,
    diagnostics?: SessionListDiagnostics,
  ) => Promise<void>,
): GatewayRequestHandler {
  return async (args) => {
    const diagnostics = startSessionListDiagnostics(
      args.respond,
      args.req.method === "sessions.subscribe" ? "sessions.subscribe" : "sessions.list",
    );
    let outcome: "returned" | "threw" = "returned";
    try {
      await handler(diagnostics ? { ...args, respond: diagnostics.respond } : args, diagnostics);
    } catch (error) {
      outcome = "threw";
      throw error;
    } finally {
      diagnostics?.finish(outcome);
    }
  };
}
