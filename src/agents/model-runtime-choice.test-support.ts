import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { setPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

export function createModelRuntimeChoiceOwnerFixture(
  config: OpenClawConfig,
  isCurrent = () => true,
  facts: Partial<
    Pick<PreparedModelRuntimeSnapshot, "authModes" | "pluginRegistry" | "modelCatalog">
  > = {},
  paths: { agentDir?: string; workspaceDir?: string } = {},
): PreparedModelRuntimeSnapshot {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const workspaceDir = paths.workspaceDir ?? "/tmp/runtime-choice";
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    catalogOwner: { agentId: "main", workspaceDir },
    agentId: "main",
    agentDir: paths.agentDir ?? "/tmp/runtime-choice/agent",
    workspaceDir,
    activeProjectKeys: [],
    authModes: facts.authModes ?? {},
    pluginRegistry: facts.pluginRegistry,
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent,
    allowGatewaySubagentBinding: false,
    modelCatalog: facts.modelCatalog ?? { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
  };
  setPreparedModelRuntimeAuthStore(owner, {
    version: 1,
    profiles: {
      "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
    },
  });
  return owner;
}
