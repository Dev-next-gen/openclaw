import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "../infra/errors.js";
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";

const MEMORY_ARTIFACT_PROVENANCE_OWNER_ID = "core:memory-artifact-provenance";
const MEMORY_ARTIFACT_PROVENANCE_NAMESPACE = "workspace-files";
const MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES = 50_000;

export type MemoryArtifactOriginClass = "agent" | "untrusted";

export type MemoryArtifactProvenance = {
  fileHash: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
};

type StoredMemoryArtifactProvenance = MemoryArtifactProvenance & {
  version: 1;
  workspaceKey: string;
  relativePath: string;
  reservationId: string;
};

type MemoryArtifactAddress = {
  workspaceKey: string;
  relativePath: string;
  storeKey: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  let canonical = resolved;
  try {
    // Provenance follows the physical workspace so symlink or junction aliases
    // cannot split the writer and reader into different trust records.
    canonical = realpathSync.native(resolved);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(extractErrorCode(error) ?? "")) {
      throw error;
    }
  }
  const normalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeMemoryArtifactRelativePath(relativePath: string): string | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  if (["MEMORY.md", "memory.md", "USER.md"].includes(normalized)) {
    return normalized;
  }
  if (!normalized.startsWith("memory/") || !normalized.endsWith(".md")) {
    return undefined;
  }
  if (normalized.startsWith("memory/dreaming/") || normalized.startsWith("memory/.dreams/")) {
    return undefined;
  }
  return normalized;
}

function resolveAddress(params: {
  workspaceDir: string;
  relativePath: string;
}): MemoryArtifactAddress | undefined {
  const relativePath = normalizeMemoryArtifactRelativePath(params.relativePath);
  if (!relativePath) {
    return undefined;
  }
  const workspaceKey = sha256(normalizeWorkspaceKey(params.workspaceDir));
  return {
    workspaceKey,
    relativePath,
    storeKey: `${workspaceKey}:${sha256(relativePath)}`,
  };
}

function openStore() {
  return createCorePluginStateSyncKeyedStore<StoredMemoryArtifactProvenance>({
    ownerId: MEMORY_ARTIFACT_PROVENANCE_OWNER_ID,
    namespace: MEMORY_ARTIFACT_PROVENANCE_NAMESPACE,
    maxEntries: MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function normalizeStoredProvenance(
  value: StoredMemoryArtifactProvenance | undefined,
  address: MemoryArtifactAddress,
): StoredMemoryArtifactProvenance | undefined {
  if (
    value?.version !== 1 ||
    value.workspaceKey !== address.workspaceKey ||
    value.relativePath !== address.relativePath ||
    !/^[a-f0-9]{64}$/u.test(value.fileHash) ||
    (value.originClass !== "agent" && value.originClass !== "untrusted") ||
    !Number.isSafeInteger(value.observedAt) ||
    typeof value.reservationId !== "string" ||
    value.reservationId.length === 0
  ) {
    return undefined;
  }
  return value;
}

export async function recordMemoryArtifactWriteProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
  contentAfter: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
}): Promise<(() => Promise<void>) | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const store = openStore();
  if (!store.update) {
    throw new Error("Memory artifact provenance updates are unavailable");
  }
  const reservationId = randomUUID();
  let previous: StoredMemoryArtifactProvenance | undefined;
  store.update(address.storeKey, (current) => {
    previous = normalizeStoredProvenance(current, address);
    const originClass =
      params.originClass === "agent" &&
      (!previous ||
        (previous.originClass === "agent" && previous.fileHash === sha256(params.contentBefore)))
        ? "agent"
        : "untrusted";
    return {
      version: 1,
      workspaceKey: address.workspaceKey,
      relativePath: address.relativePath,
      fileHash: sha256(params.contentAfter),
      originClass,
      observedAt: params.observedAt,
      reservationId,
    };
  });

  return async () => {
    const rollbackStore = openStore();
    if (previous) {
      rollbackStore.update?.(address.storeKey, (current) =>
        current?.reservationId === reservationId ? previous : undefined,
      );
      return;
    }
    rollbackStore.deleteIf?.(
      address.storeKey,
      (current) => current.reservationId === reservationId,
    );
  };
}

export async function clearMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
}): Promise<void> {
  const address = resolveAddress(params);
  if (!address) {
    return;
  }
  const expectedHash = sha256(params.contentBefore);
  openStore().deleteIf?.(address.storeKey, (current) => current.fileHash === expectedHash);
}

export async function readMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<MemoryArtifactProvenance | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const stored = normalizeStoredProvenance(openStore().lookup(address.storeKey), address);
  return stored
    ? {
        fileHash: stored.fileHash,
        originClass: stored.originClass,
        observedAt: stored.observedAt,
      }
    : undefined;
}

export async function listMemoryArtifactProvenance(params: {
  workspaceDir: string;
}): Promise<Array<{ relativePath: string; provenance: MemoryArtifactProvenance }>> {
  const workspaceKey = sha256(normalizeWorkspaceKey(params.workspaceDir));
  const prefix = `${workspaceKey}:`;
  return openStore()
    .entries()
    .filter((entry) => entry.key.startsWith(prefix))
    .flatMap((entry) => {
      const address = {
        workspaceKey,
        relativePath: entry.value.relativePath,
        storeKey: entry.key,
      };
      const stored = normalizeStoredProvenance(entry.value, address);
      return stored
        ? [
            {
              relativePath: stored.relativePath,
              provenance: {
                fileHash: stored.fileHash,
                originClass: stored.originClass,
                observedAt: stored.observedAt,
              },
            },
          ]
        : [];
    });
}

/** Automatic context and dreaming must not promote quarantined or unknown session sources. */
export async function isMemoryArtifactEligibleForAutomaticContext(params: {
  workspaceDir: string;
  relativePath: string;
  content?: string;
}): Promise<boolean> {
  const requestedPath = normalizeMemoryArtifactRelativePath(params.relativePath);
  if (!requestedPath) {
    return false;
  }
  // Classification follows the source, not a lexical alias supplied by an index
  // or bootstrap hook. An alias outside the workspace has no promotion authority.
  const workspaceRoot = await fs.realpath(params.workspaceDir);
  let sourcePath: string;
  try {
    sourcePath = await fs.realpath(path.join(workspaceRoot, requestedPath));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(extractErrorCode(error) ?? "")) {
      return false;
    }
    throw error;
  }
  const relativePath = normalizeMemoryArtifactRelativePath(
    path.relative(workspaceRoot, sourcePath).replaceAll(path.sep, "/"),
  );
  if (!relativePath) {
    return false;
  }
  const provenance = await readMemoryArtifactProvenance({ ...params, relativePath });
  // Untracked workspace files remain the operator-owned compatibility boundary.
  if (!provenance) {
    return true;
  }
  if (provenance.originClass === "untrusted") {
    return false;
  }
  const content =
    params.content ?? (await fs.readFile(path.join(params.workspaceDir, relativePath), "utf8"));
  return provenance.fileHash === sha256(content);
}
