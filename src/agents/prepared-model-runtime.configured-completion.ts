import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { resolveLoadedProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { buildConfiguredFallbackModel } from "./embedded-agent-runner/model.configured-fallback.js";
import { resolveExplicitModelWithRegistry } from "./embedded-agent-runner/model.registry-resolution.js";
import { resolveManifestModelCatalogProviderAliasMetadata } from "./embedded-agent-runner/model.static-catalog.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { modelKey } from "./model-ref-shared.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { buildAllowedModelSet, buildModelAliasIndex } from "./model-selection-shared.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import type {
  PreparedConfiguredRuntimeModel,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export function completeConfiguredRuntimeModels(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  modelRegistry: ModelRegistry,
): readonly PreparedConfiguredRuntimeModel[] {
  const prepareAliases = (models: readonly PreparedConfiguredRuntimeModel[]) => {
    const { config, agentId } = agentFacts.input;
    const defaults = resolveDefaultModelForAgent({ cfg: config, agentId });
    const selection = {
      cfg: config,
      agentId,
      defaultProvider: defaults.provider,
      defaultModel: defaults.model,
      manifestPlugins: pluginGeneration.pluginMetadataSnapshot.plugins,
    };
    const aliases = buildModelAliasIndex(selection);
    const selectedAliases = new Map(
      [...aliases.byAlias.values()].map(({ alias, ref }) => [
        modelKey(ref.provider, ref.model),
        alias,
      ]),
    );
    const policy =
      selectedAliases.size > 0
        ? buildAllowedModelSet({
            ...selection,
            catalog: [
              ...modelRegistry.getAll().map(modelCatalogRowToEntry),
              ...models.map(({ model }) => modelCatalogRowToEntry(model)),
            ],
          })
        : undefined;
    return models.map((entry) => {
      const alias = selectedAliases.get(modelKey(entry.provider, entry.modelId));
      // Keep the catalog donor for later account materialization; only its admitted
      // configured transport can advertise an alias in this generation.
      const supported =
        alias && policy?.allows({ provider: entry.provider, model: entry.modelId })
          ? resolveExplicitModelWithRegistry({
              provider: entry.provider,
              modelId: entry.modelId,
              preparedCatalogModel: entry.model,
              modelRegistry,
              cfg: config,
              agentDir: agentFacts.input.agentDir,
              workspaceDir: agentFacts.input.workspaceDir,
              manifestAlias: resolveManifestModelCatalogProviderAliasMetadata({
                provider: entry.provider,
                modelId: entry.modelId,
                cfg: config,
                workspaceDir: agentFacts.input.workspaceDir,
              }),
            })
          : undefined;
      return { ...entry, selectionAlias: supported?.kind === "resolved" ? alias : undefined };
    });
  };
  const { input, configuredModelRefs, configuredRuntimeModels, env } = agentFacts;
  const { config, agentDir, workspaceDir } = input;
  // Both startup and full discovery complete static misses from their captured registry;
  // borrowing an ambient plugin generation would change configured model ownership.
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: pluginGeneration.pluginRegistry,
    },
    () => {
      if (!pluginGeneration.pluginRegistry) {
        return prepareAliases(configuredRuntimeModels);
      }
      const existing = new Map(
        configuredRuntimeModels.map((configured) => [
          buildModelCatalogMergeKey(configured.provider, configured.modelId),
          configured,
        ]),
      );
      const completed: PreparedConfiguredRuntimeModel[] = [];
      const seen = new Set<string>();
      for (const ref of configuredModelRefs) {
        const { provider, modelId } = ref;
        const key = buildModelCatalogMergeKey(provider, modelId);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const model =
          existing.get(key)?.model ??
          resolveLoadedProviderRuntimePlugin({
            provider,
            modelId,
            config,
            workspaceDir,
            env,
          })?.resolveDynamicModel?.({
            config,
            agentDir,
            workspaceDir,
            provider,
            modelId,
            modelRegistry,
            providerConfig:
              config.models?.providers?.[provider] ??
              findNormalizedProviderValue(config.models?.providers, provider),
          }) ??
          buildConfiguredFallbackModel({
            provider,
            modelId,
            cfg: config,
            agentDir,
            workspaceDir,
            providerMetadataOwners: pluginGeneration.pluginMetadataSnapshot.owners,
            manifestAlias: resolveManifestModelCatalogProviderAliasMetadata({
              provider,
              modelId,
              cfg: config,
              workspaceDir,
            }),
          });
        if (model) {
          completed.push({ ...ref, model });
        }
      }
      return prepareAliases(completed);
    },
  );
}
