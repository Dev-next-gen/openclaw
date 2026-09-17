import { createHash, randomUUID } from "node:crypto";
import type { PluginHookAgentContext, PluginHookToolAuthority } from "./hook-types.js";

export type PromptToolAuthorityInput = {
  activeToolNames: readonly string[];
  signal?: AbortSignal;
};

/** A plugin cannot retain prompt-time memory access after the turn or hook closes. */
export function createPromptToolAuthority(
  context: PluginHookAgentContext,
  input: PromptToolAuthorityInput,
): { authority: PluginHookToolAuthority; close: () => void } {
  const names = [
    ...new Set(input.activeToolNames.map((name) => name.trim().toLowerCase())),
  ].toSorted();
  const allowed = new Set(names);
  let active = true;
  const assertActive = () => {
    if (!active || input.signal?.aborted) {
      throw new Error("prompt tool authority is no longer active");
    }
  };
  return {
    authority: Object.freeze({
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            context.runId ?? randomUUID(),
            context.agentId,
            context.sessionKey,
            context.sessionId,
            context.modelProviderId,
            context.modelId,
            names,
          ]),
        )
        .digest("hex"),
      allows(toolName: string) {
        assertActive();
        return allowed.has(toolName.trim().toLowerCase());
      },
      assertActive,
    }),
    close: () => {
      active = false;
    },
  };
}
