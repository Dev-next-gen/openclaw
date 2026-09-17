// Media read capability helpers gate file reads by configured media access rules.
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveGroupToolPolicy } from "../agents/agent-tools.policy.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveManagedMediaRoot } from "../agents/sandbox-paths.js";
import { resolveSenderToolPolicy } from "../agents/sender-tool-policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../agents/tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { resolveConfigDir } from "../utils.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
import { getAgentScopedMediaLocalRootsForSources } from "./local-roots.js";

type OutboundHostMediaPolicyContext = {
  sessionKey?: string;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
};

function isAgentScopedMediaReadAllowedByToolPolicy(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
  } & OutboundHostMediaPolicyContext,
): boolean {
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.accountId,
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
  const senderPolicy = resolveSenderToolPolicy({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
  if (!isToolAllowedByPolicies("read", [groupPolicy, senderPolicy])) {
    return false;
  }
  return true;
}

/** Creates a host reader bound to the agent workspace and configured local-file safety checks. */
export function createAgentScopedHostMediaReadFile(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    workspaceDir?: string;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaReadFile | undefined {
  if (
    !resolveEffectiveToolFsRootExpansionAllowed({ cfg: params.cfg, agentId: params.agentId }) ||
    !isAgentScopedMediaReadAllowedByToolPolicy(params)
  ) {
    return undefined;
  }
  const inferredWorkspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const workspaceRoot = resolveWorkspaceRoot(inferredWorkspaceDir);
  return async (filePath: string) => {
    const resolvedPath = resolvePathFromInput(filePath, workspaceRoot);
    return (await readLocalFileSafely({ filePath: resolvedPath })).buffer;
  };
}

function appendWorkspaceDirToLocalRoots(
  roots: readonly string[] | undefined,
  workspaceDir?: string,
): readonly string[] | undefined {
  if (!workspaceDir) {
    return roots;
  }
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots?.length) {
    return [resolvedWorkspaceDir];
  }
  if (roots.some((root) => path.resolve(root) === resolvedWorkspaceDir)) {
    return roots;
  }
  return [...roots, resolvedWorkspaceDir];
}

/** Resolves roots and optional host read capability for outbound media in an agent context. */
export function resolveAgentScopedOutboundMediaAccess(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    mediaSources?: readonly string[];
    workspaceDir?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaReadFile?: OutboundMediaReadFile;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaAccess {
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const mediaReadAllowed = isAgentScopedMediaReadAllowedByToolPolicy(params);
  // A sender's read denial also removes supplied host readers and workspace roots.
  // Host-generated managed media remains deliverable without granting arbitrary reads.
  const baseLocalRoots = mediaReadAllowed
    ? (params.mediaAccess?.localRoots ??
      getAgentScopedMediaLocalRootsForSources({
        cfg: params.cfg,
        agentId: params.agentId,
        mediaSources: params.mediaSources,
      }))
    : getManagedMediaLocalRoots(params.mediaSources);
  const localRoots = mediaReadAllowed
    ? appendWorkspaceDirToLocalRoots(baseLocalRoots, resolvedWorkspaceDir)
    : baseLocalRoots;
  const readFile = mediaReadAllowed
    ? (params.mediaAccess?.readFile ??
      params.mediaReadFile ??
      createAgentScopedHostMediaReadFile({
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceDir: resolvedWorkspaceDir,
        sessionKey: params.sessionKey,
        messageProvider: params.messageProvider,
        groupId: params.groupId,
        groupChannel: params.groupChannel,
        groupSpace: params.groupSpace,
        accountId: params.accountId,
        requesterSenderId: params.requesterSenderId,
        requesterSenderName: params.requesterSenderName,
        requesterSenderUsername: params.requesterSenderUsername,
        requesterSenderE164: params.requesterSenderE164,
      }))
    : undefined;
  return {
    ...(localRoots?.length ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
  };
}

function getManagedMediaLocalRoots(mediaSources?: readonly string[]): readonly string[] {
  const roots = new Set([path.join(resolveConfigDir(), "media", "outbound")]);
  for (const source of mediaSources ?? []) {
    const root = resolveManagedMediaRoot(source);
    if (root) roots.add(root);
  }
  return Array.from(roots);
}
