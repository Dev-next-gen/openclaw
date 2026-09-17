/** Captures and revalidates the directory identity used by exec authorization. */
import fs from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "./fs-safe-advanced.js";

export const APPROVAL_CWD_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval cwd changed before execution";

export class ApprovedCwdDriftError extends Error {
  constructor() {
    super(APPROVAL_CWD_DRIFT_DENIED_MESSAGE);
    this.name = "ApprovedCwdDriftError";
  }
}

export type ApprovedCwdSnapshot = {
  cwd: string;
  stat: fs.Stats;
};

export function captureApprovedCwdSnapshotSync(
  cwd: string,
): { ok: true; snapshot: ApprovedCwdSnapshot } | { ok: false; message: string } {
  const requestedCwd = path.resolve(cwd);
  let cwdLstat: fs.Stats;
  let cwdStat: fs.Stats;
  let cwdReal: string;
  let cwdRealStat: fs.Stats;
  try {
    cwdLstat = fs.lstatSync(requestedCwd);
    cwdStat = fs.statSync(requestedCwd);
    cwdReal = fs.realpathSync(requestedCwd);
    cwdRealStat = fs.statSync(cwdReal);
  } catch {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd",
    };
  }
  if (!cwdStat.isDirectory()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires cwd to be a directory",
    };
  }
  if (hasMutableSymlinkPathComponentSync(requestedCwd) || cwdLstat.isSymbolicLink()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink path components)",
    };
  }
  if (
    !sameFileIdentity(cwdStat, cwdLstat) ||
    !sameFileIdentity(cwdStat, cwdRealStat) ||
    !sameFileIdentity(cwdLstat, cwdRealStat)
  ) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: approval cwd identity mismatch" };
  }
  return { ok: true, snapshot: { cwd: cwdReal, stat: cwdStat } };
}

/** Rechecks the exact directory object immediately before process launch. */
export function revalidateApprovedCwdSnapshot(snapshot: ApprovedCwdSnapshot): boolean {
  const current = captureApprovedCwdSnapshotSync(snapshot.cwd);
  return current.ok && sameFileIdentity(snapshot.stat, current.snapshot.stat);
}

function pathComponentsFromRootSync(targetPath: string): string[] {
  const absolute = path.resolve(targetPath);
  const parts: string[] = [];
  let cursor = absolute;
  while (true) {
    parts.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return parts;
    }
    cursor = parent;
  }
}

function isOwnedByCurrentProcessSync(candidate: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return false;
  }
  try {
    return fs.statSync(candidate).uid === process.getuid();
  } catch {
    return false;
  }
}

function isMutableByCurrentProcessSync(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return isOwnedByCurrentProcessSync(candidate);
  }
}

function hasMutableSymlinkPathComponentSync(targetPath: string): boolean {
  for (const component of pathComponentsFromRootSync(targetPath)) {
    try {
      if (!fs.lstatSync(component).isSymbolicLink()) {
        continue;
      }
      const parentDir = path.dirname(component);
      if (isMutableByCurrentProcessSync(parentDir)) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}
