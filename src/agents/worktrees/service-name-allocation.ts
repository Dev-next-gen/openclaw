import path from "node:path";
import { commandError, listGitWorktrees, runGit, worktreePathExists } from "./git.js";
import { worktreeOwnerMatches } from "./owner.js";
import { listRegistryWorktrees } from "./registry.js";
import type { CreateManagedWorktreeParams } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateWorktreeName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("worktree name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

export function findWorktreeByName(env: NodeJS.ProcessEnv, fingerprint: string, name: string) {
  return listRegistryWorktrees(env).find(
    (record) => record.repoFingerprint === fingerprint && record.name === name,
  );
}

async function nameIsUnavailable(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  fingerprint: string,
  root: string,
  name: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): Promise<boolean> {
  const worktreePath = path.join(root, name);
  const registered = findWorktreeByName(env, fingerprint, name);
  if (
    owner.ownerId &&
    registered &&
    registered.removedAt === undefined &&
    worktreeOwnerMatches(registered, owner)
  ) {
    return false;
  }
  if (registered || (await worktreePathExists(worktreePath))) {
    return true;
  }
  const branch = `openclaw/${name}`;
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code === 0) {
    return true;
  }
  if (branchExists.code !== 1) {
    throw commandError("git show-ref --verify", branchExists);
  }
  return (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
}

function appendNameOrdinal(name: string, ordinal: number): string {
  const suffix = `-${ordinal}`;
  return `${name.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

export async function generateAvailableWorktreeName(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  fingerprint: string,
  root: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  suggestedName: string,
): Promise<string> {
  validateWorktreeName(suggestedName);
  for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
    const candidate = ordinal === 1 ? suggestedName : appendNameOrdinal(suggestedName, ordinal);
    if (!(await nameIsUnavailable(env, repoRoot, fingerprint, root, candidate, owner))) {
      return candidate;
    }
  }
  throw new Error(`no available worktree name for ${suggestedName}`);
}
