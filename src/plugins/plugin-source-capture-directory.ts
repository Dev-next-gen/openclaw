import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";

const CAPTURE_PREFIX = "openclaw-plugin-build-";
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1_000;
const sweeps = new Map<string, Promise<void>>();

async function removeOrphanedCaptures(root: string): Promise<void> {
  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const uid = process.getuid?.();
  for (const entry of await fsPromises.readdir(root, { withFileTypes: true })) {
    // Older captures have no creator identity and may still serve a running Gateway.
    const match = /^openclaw-plugin-build-([1-9]\d*)-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!entry.isDirectory() || !match) {
      continue;
    }
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid) {
      continue;
    }
    const directory = path.join(root, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fsPromises.lstat(directory);
    } catch {
      // Another process may already have reclaimed it; unreadable entries stay untouched.
      continue;
    }
    if (
      !stat.isDirectory() ||
      (uid !== undefined && stat.uid !== uid) ||
      stat.mtimeMs > cutoff ||
      !isPidDefinitelyDead(pid)
    ) {
      continue;
    }
    await removeTemporaryArtifacts(directory, "Abandoned plugin source capture");
  }
}

/** Startup and source acquisition share one best-effort scan per temporary root. */
export function sweepPluginSourceCaptureDirectories(directory = tmpdir()): Promise<void> {
  const root = path.resolve(directory);
  let sweep = sweeps.get(root);
  if (!sweep) {
    sweep = removeOrphanedCaptures(root).catch((error: unknown) => {
      process.emitWarning(`Plugin source capture cleanup could not scan ${root}: ${String(error)}`);
    });
    sweeps.set(root, sweep);
  }
  return sweep;
}

export function createPluginSourceCaptureDirectory(root: string): string {
  void sweepPluginSourceCaptureDirectories(root);
  const directory = fs.mkdtempSync(path.join(root, `${CAPTURE_PREFIX}${process.pid}-`));
  try {
    const canonical = fs.realpathSync(directory);
    fs.chmodSync(canonical, 0o700);
    return canonical;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
