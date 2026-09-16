import { describe, expect, it, vi, type Mock } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createGatewaySession } from "../session-create-service.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type CatalogContext = Pick<GatewayRequestContext, "loadGatewayModelCatalogSnapshot">;

export function registerModelOnlyRuntimeTests(harness: {
  getConfig: () => OpenClawConfig;
  context: () => {
    loadGatewayModelCatalogSnapshot: Mock<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>;
  };
  catalogSnapshot: (
    entries: ModelCatalogEntry[],
  ) => Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>;
  prepare: Mock<typeof preparePublishedModelRuntimeChoice>;
  pluginMetadata: { snapshot: PluginMetadataSnapshot | undefined };
  queueRuntimeSelection: (sessionKey: string) => FollowupRun["run"];
  patchSession: (
    request: Record<string, unknown>,
    scopes: string[],
    requestContext: CatalogContext,
  ) => Promise<Parameters<RespondFn>>;
}): void {
  const { patchSession } = harness;
  describe("model-only session runtime selection", () => {
    it("leaves no new session when its model-only runtime owner expires before commit", async () => {
      const sessionKey = "agent:main:model-only-runtime-stale";
      const requestContext = harness.context();
      requestContext.loadGatewayModelCatalogSnapshot.mockResolvedValue(
        harness.catalogSnapshot([
          {
            provider: "anthropic",
            id: "claude-sonnet-4-6",
            name: "Native model",
            reasoning: false,
            nativeRuntime: "claude-cli",
          },
        ]),
      );
      harness.prepare.mockResolvedValue({
        kind: "ready",
        runtimeId: "claude-cli",
        validate: vi
          .fn<() => string | undefined>()
          .mockReturnValueOnce(undefined)
          .mockReturnValue("The selected runtime is no longer available."),
      });
      await expect(
        createGatewaySession({
          cfg: harness.getConfig(),
          key: sessionKey,
          model: "anthropic/claude-sonnet-4-6",
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
          loadGatewayModelCatalogSnapshot: requestContext.loadGatewayModelCatalogSnapshot,
        }),
      ).rejects.toThrow("The selected runtime is no longer available.");
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
    });

    it.each(["claude-cli", "openclaw"])(
      "keeps a compatible %s pin when only the model changes",
      async (runtime) => {
        const sessionKey = "agent:main:retained-runtime";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            providerOverride: "anthropic",
            modelOverride: "claude-opus-4-6",
            agentRuntimeOverride: runtime,
          },
        );
        const requestContext = harness.context();
        harness.prepare.mockImplementation(async (input) => ({
          kind: "ready",
          runtimeId: input.runtimeId ?? input.preferredRuntimeId ?? "openclaw",
          validate: () => undefined,
        }));
        const registry = createEmptyPluginRegistry();
        registry.cliBackends.push({
          pluginId: "anthropic",
          source: "fixture",
          backend: { id: "claude-cli", modelProvider: "anthropic", config: { command: "claude" } },
        });
        await withPluginRuntimeRegistryScope(registry, async () => {
          const response = await patchSession(
            { key: sessionKey, model: "anthropic/claude-sonnet-4-6" },
            ["operator.admin"],
            requestContext,
          );
          expect(response[0], JSON.stringify(response)).toBe(true);
          expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
            modelOverride: "claude-sonnet-4-6",
            agentRuntimeOverride: runtime,
          });
        });
      },
    );

    it.each([
      {
        previous: undefined,
        runtime: "native",
        provider: "native-provider",
        operation: "patch-default",
      },
      {
        previous: "previous-native",
        runtime: "native",
        provider: "native-provider",
        operation: "patch-default",
      },
      {
        previous: undefined,
        runtime: "native",
        provider: "native-provider",
        operation: "create-new",
      },
      { previous: undefined, runtime: "native", provider: "native-provider", operation: "patch" },
      {
        previous: "previous-native",
        runtime: "native",
        provider: "native-provider",
        operation: "patch",
      },
      {
        previous: "previous-native",
        runtime: "claude-cli",
        provider: "anthropic",
        operation: "patch",
      },
      {
        previous: "claude-cli",
        runtime: "native",
        provider: "native-provider",
        operation: "patch",
      },
      {
        previous: "previous-native",
        runtime: "native",
        provider: "native-provider",
        operation: "create",
      },
    ])(
      "selects $runtime from $previous through $operation",
      async ({ previous, runtime, provider, operation }) => {
        const fresh = operation === "create-new";
        const sessionKey = fresh ? "agent:main:native-new" : "agent:main:native-default";
        if (!fresh) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: sessionKey,
              updatedAt: 1,
              agentHarnessId: previous,
              agentRuntimeOverride: previous,
            },
          );
        } else {
          expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
        }
        const requestContext = harness.context();
        requestContext.loadGatewayModelCatalogSnapshot.mockResolvedValue(
          harness.catalogSnapshot([
            {
              provider,
              id: "model",
              name: "Selected model",
              reasoning: false,
              ...(runtime === "native" ? { nativeRuntime: runtime } : {}),
            },
          ]),
        );
        harness.prepare.mockResolvedValue({
          kind: "ready",
          runtimeId: runtime,
          validate: () => undefined,
        });
        const registry = createEmptyPluginRegistry();
        for (const id of ["native", "previous-native"]) {
          registry.agentHarnesses.push({
            pluginId: id,
            source: "fixture",
            harness: { id, label: id, supports: () => ({ supported: true }), runAttempt: vi.fn() },
          });
        }
        registry.cliBackends.push({
          pluginId: "anthropic",
          source: "fixture",
          backend: { id: "claude-cli", modelProvider: "anthropic", config: { command: "claude" } },
        });
        const queued = fresh ? undefined : harness.queueRuntimeSelection(sessionKey);
        const previousMetadata = harness.pluginMetadata.snapshot;
        harness.pluginMetadata.snapshot = createPluginMetadataSnapshotFixture({
          plugins: ["codex", "native", "previous-native"].map((id) => ({
            id,
            activation: { onAgentHarnesses: [id] },
          })),
        });
        try {
          await withPluginRuntimeRegistryScope(registry, async () => {
            if (operation === "create" || fresh) {
              expect(
                await createGatewaySession({
                  cfg: harness.getConfig(),
                  key: sessionKey,
                  model: `${provider}/model`,
                  commandSource: "test",
                  allowExistingModelSelection: !fresh,
                  operatorRoleActor: { kind: "system" },
                  loadGatewayModelCatalogSnapshot: requestContext.loadGatewayModelCatalogSnapshot,
                }),
              ).toMatchObject({ ok: true });
            } else {
              const response = await patchSession(
                {
                  key: sessionKey,
                  model: `${provider}/model`,
                  ...(operation === "patch-default" ? { agentRuntime: null } : {}),
                },
                ["operator.admin"],
                requestContext,
              );
              expect(response[0], JSON.stringify(response)).toBe(true);
            }
            if (queued) {
              expect(queued).toMatchObject({
                provider,
                model: "model",
                requestedRouteResolution: "resolved",
                authProfileId: undefined,
                authProfileIdSource: undefined,
                thinkLevel: "off",
              });
            }
            if (operation === "patch-default") {
              expect(harness.prepare).toHaveBeenCalledWith(
                expect.objectContaining({
                  runtimeId: undefined,
                  preferredRuntimeId: undefined,
                }),
              );
            }
            const stored = loadSessionEntry({ agentId: "main", sessionKey });
            expect(stored).toMatchObject({
              providerOverride: provider,
              modelOverride: "model",
              agentRuntimeOverride: runtime,
            });
            expect(
              resolveSessionRuntimeOverrideForProvider({
                provider,
                entry: stored,
                cfg: harness.getConfig(),
              }),
            ).toBe(runtime);
          });
        } finally {
          harness.pluginMetadata.snapshot = previousMetadata;
          clearFollowupQueue(sessionKey);
        }
      },
    );
  });
}
