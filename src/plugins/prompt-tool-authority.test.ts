import { describe, expect, it } from "vitest";
import type { PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";
import { createPromptToolAuthority } from "./prompt-tool-authority.js";

describe("prompt tool authority", () => {
  it("binds permission and cache identity to the exact model and finalized tool set", () => {
    const context = { runId: "run", agentId: "agent", modelId: "gpt-5.5" };
    const lease = createPromptToolAuthority(context, { activeToolNames: ["memory_search"] });
    expect(lease.authority.allows("memory_search")).toBe(true);
    expect(lease.authority.allows("memory_recall")).toBe(false);
    expect(
      createPromptToolAuthority(context, { activeToolNames: [] }).authority.fingerprint,
    ).not.toBe(lease.authority.fingerprint);
    expect(
      createPromptToolAuthority(
        { ...context, modelId: "another" },
        { activeToolNames: ["memory_search"] },
      ).authority.fingerprint,
    ).not.toBe(lease.authority.fingerprint);
    lease.close();
    expect(() => lease.authority.allows("memory_search")).toThrow("no longer active");
  });

  it("fails closed on cancellation and closes authority after the hook finishes", async () => {
    const controller = new AbortController();
    let captured: PluginHookAgentContext["toolAuthority"];
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: (_event, context) => {
            captured = (context as PluginHookAgentContext).toolAuthority;
            expect(captured?.allows("memory_search")).toBe(true);
            return { prependContext: "authorized memory" };
          },
        },
      ]),
    );
    await expect(
      runner.runBeforePromptBuild(
        { prompt: "hello", messages: [] },
        {},
        { activeToolNames: ["memory_search"], signal: controller.signal },
      ),
    ).resolves.toMatchObject({ prependContext: "authorized memory" });
    expect(() => captured?.assertActive()).toThrow("no longer active");
    const lease = createPromptToolAuthority(
      {},
      { activeToolNames: ["memory_search"], signal: controller.signal },
    );
    controller.abort();
    expect(() => lease.authority.allows("memory_search")).toThrow("no longer active");
  });

  it("does not accept caller-supplied authority on legacy pre-policy dispatch", async () => {
    let captured: PluginHookAgentContext["toolAuthority"];
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: (_event, context) => {
            captured = (context as PluginHookAgentContext).toolAuthority;
          },
        },
      ]),
    );
    const forged = { fingerprint: "unbound", allows: () => true, assertActive: () => {} };
    await runner.runBeforePromptBuild({ prompt: "hello", messages: [] }, { toolAuthority: forged });
    expect(captured).toBeUndefined();
  });
});
