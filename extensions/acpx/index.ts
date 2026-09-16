/**
 * ACPX runtime plugin entry. It registers the embedded ACP backend service and
 * wires reply-dispatch hooks into the plugin SDK runtime.
 */
import { createAgentRegistry } from "acpx/agent-registry";
import { tryDispatchAcpReplyHook } from "openclaw/plugin-sdk/acp-runtime-backend";
import { createAcpxRuntimeService } from "./register.runtime.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { createAcpAgentHarness } from "./src/harness.js";
import { registerPiSessionCatalog } from "./src/pi-session-catalog-plugin.js";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  register(api: OpenClawPluginApi) {
    registerPiSessionCatalog(api);
    const service = createAcpxRuntimeService({
      pluginConfig: api.pluginConfig,
      openKeyedStore: (options) => api.runtime.state.openKeyedStore(options),
    });
    api.registerService(service);
    const registry = createAgentRegistry();
    for (const agentId of ["opencode", "qwen", "pi", "kilocode"]) {
      const agent = registry.inspect(agentId);
      if (!agent) {
        throw new Error(`Unknown ACP harness: ${agentId}`);
      }
      api.registerAgentHarness(
        createAcpAgentHarness({
          agent: agent.id,
          label: agent.name,
          api,
          getRuntime: service.getRuntime,
          shutdown: () =>
            service.stop?.({
              config: api.config,
              stateDir: api.runtime.state.resolveStateDir(),
              logger: api.logger,
            }),
        }),
      );
    }
    api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  },
};

export default plugin;
