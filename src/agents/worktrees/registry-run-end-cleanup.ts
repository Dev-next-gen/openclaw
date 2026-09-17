import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ManagedWorktreeRunEndCleanup } from "./types.js";

export function parseWorktreeRunEndCleanup(
  raw: string | null | undefined,
): ManagedWorktreeRunEndCleanup | undefined {
  if (raw == null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.at !== "number" ||
      !Number.isInteger(parsed.at) ||
      parsed.at < 0
    ) {
      return undefined;
    }
    const at = parsed.at;
    switch (parsed.outcome) {
      case "failed":
        return typeof parsed.reason === "string" &&
          parsed.reason.length > 0 &&
          parsed.reason.length <= 500
          ? { outcome: parsed.outcome, at, reason: parsed.reason }
          : undefined;
      case "removed-lossless":
      case "retained-busy":
      case "retained-dirty":
      case "retained-unpushed":
      case "retained-provisioned-drift":
        return parsed.reason === undefined ? { outcome: parsed.outcome, at } : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
