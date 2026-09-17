import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export type ThreadOwnerToken = {
  invalidated: boolean;
  invalidate: () => void;
};

export type ThreadReleaseTransition = {
  completion: Promise<void>;
  physicalRelease?: Promise<void>;
  retainedOwnerToken?: ThreadOwnerToken;
  invalidated?: boolean;
};

export function createThreadOwnerToken(
  threadId: string,
  onInvalidated?: () => void,
): ThreadOwnerToken {
  const owner: ThreadOwnerToken = {
    invalidated: false,
    invalidate: () => {
      if (owner.invalidated) {
        return;
      }
      owner.invalidated = true;
      try {
        onInvalidated?.();
      } catch (error) {
        embeddedAgentLog.warn("codex thread ownership invalidation failed", {
          threadId,
          reason: formatErrorMessage(error),
        });
      }
    },
  };
  return owner;
}

type ThreadOwnershipState = {
  retainedThreads: Pick<Map<string, { ownerToken?: ThreadOwnerToken }>, "get" | "delete">;
  claimedThreads: Pick<Map<string, ThreadOwnerToken>, "get" | "delete">;
  releasingThreads: Pick<Map<string, ThreadReleaseTransition>, "get">;
};

export function hasThreadOwnership(
  runtime: (ThreadOwnershipState & { closed: boolean }) | undefined,
  threadId: string,
): boolean {
  return (
    runtime !== undefined &&
    !runtime.closed &&
    (runtime.retainedThreads.get(threadId) !== undefined ||
      runtime.releasingThreads.get(threadId) !== undefined ||
      runtime.claimedThreads.get(threadId) !== undefined)
  );
}

export function invalidateThreadOwnership(runtime: ThreadOwnershipState, threadId: string): void {
  const retainedOwner = runtime.retainedThreads.get(threadId)?.ownerToken;
  const claimedOwner = runtime.claimedThreads.get(threadId);
  const releasing = runtime.releasingThreads.get(threadId);
  if (releasing) {
    releasing.invalidated = true;
  }
  runtime.retainedThreads.delete(threadId);
  runtime.claimedThreads.delete(threadId);
  retainedOwner?.invalidate();
  claimedOwner?.invalidate();
  releasing?.retainedOwnerToken?.invalidate();
}

export function forgetThreadOwnership(
  runtime: ThreadOwnershipState,
  threadId: string,
  owner: ThreadOwnerToken,
): boolean {
  let forgotten = false;
  if (runtime.claimedThreads.get(threadId) === owner) {
    runtime.claimedThreads.delete(threadId);
    forgotten = true;
  }
  if (runtime.retainedThreads.get(threadId)?.ownerToken === owner) {
    runtime.retainedThreads.delete(threadId);
    forgotten = true;
  }
  const releasing = runtime.releasingThreads.get(threadId);
  if (releasing?.retainedOwnerToken === owner) {
    releasing.invalidated = true;
    forgotten = true;
  }
  if (forgotten) {
    owner.invalidate();
  }
  return forgotten;
}
