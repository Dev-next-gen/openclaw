import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

/** Operator message RPCs cannot preserve the source of an agent's shell report. */
export function assertGatewayCliMessageContext(method: string, params?: unknown): void {
  if (process.env.OPENCLAW_SHELL !== "exec") {
    return;
  }
  const input = method === "sessions.create" ? asNullableRecord(params) : null;
  const createsInitialTurn =
    input &&
    ([input.message, input.task].some((value) => typeof value === "string" && value.trim()) ||
      (Array.isArray(input.attachments) && input.attachments.length > 0));
  if (
    createsInitialTurn ||
    method === "sessions.send" ||
    method === "sessions.steer" ||
    method === "chat.send" ||
    method === "agent"
  ) {
    // This inherited marker only refuses accidental operator re-entry. It is not
    // authentication, and must never mint provenance or grant a missing tool.
    throw new Error(
      `Gateway ${method} from agent exec would lose inter-session attribution. ` +
        "Use the attributed session-messaging tool available to this run, or return the result " +
        "through normal subagent completion. Do not retry through another CLI route or remove the exec marker.",
    );
  }
}
