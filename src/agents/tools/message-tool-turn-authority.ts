import { isFencedProviderReadAction } from "../../channels/plugins/message-action-dispatch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";

/** Keep discovery and execution bound to the same private turn identity. */
export function createMessageToolTurnAuthority(params: {
  token?: string;
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  getConfig: () => OpenClawConfig;
  admitScheduledInvocation?: () => OpenClawConfig;
}) {
  const { token, agentId, runId, sessionKey, sessionId } = params;
  const lookup =
    agentId && sessionKey ? { token, agentId, runId, sessionKey, sessionId } : undefined;
  const resolve = () => lookup && resolveMessageActionTurnAuthorization(lookup);
  return {
    beginInvocation: (action: string) => {
      const authorization = resolve();
      const admitScheduled = authorization?.scheduled && params.admitScheduledInvocation;
      if (authorization?.scheduled && !admitScheduled) {
        throw new Error("Scheduled message invocation requires current tool policy admission.");
      }
      return {
        authorization,
        config: admitScheduled ? admitScheduled() : params.getConfig(),
        scheduledRead: isFencedProviderReadAction(action) ? authorization?.scheduled : undefined,
        assertDashboardReadCurrent: isFencedProviderReadAction(action)
          ? authorization?.assertDashboardReadCurrent
          : undefined,
      };
    },
    assertCurrent: () => {
      if (token?.trim() && (!lookup || !resolveMessageActionTurnCapability(lookup))) {
        throw new Error("message action turn capability is no longer active");
      }
    },
  };
}
