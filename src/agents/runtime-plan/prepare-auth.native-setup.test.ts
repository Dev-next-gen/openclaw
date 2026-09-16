import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPluginManifest, PLUGIN_MANIFEST_FILENAME } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveBundledPluginPublicModulePath } from "../../test-utils/bundled-plugin-public-surface.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveAgentHarnessPreparedAuthSupport } from "../harness/support.js";
import { resolveProviderDirectAuthPlanningEvidence } from "../model-auth-env.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));
function authStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return { version: 1, profiles };
}
describe("native runtime setup auth evidence", () => {
  const loadedManifest = loadPluginManifest(
    path.dirname(
      resolveBundledPluginPublicModulePath({
        pluginId: "opencode",
        artifactBasename: PLUGIN_MANIFEST_FILENAME,
      }),
    ),
    false,
  );
  if (!loadedManifest.ok) {
    throw new Error(loadedManifest.error);
  }
  const opencodeManifest = loadedManifest.manifest;
  const nativeOpencodeAuth = {
    provider: "opencode",
    modelId: "big-pickle",
    config: {},
    env: {},
    harnessId: "opencode",
    harnessRuntime: "opencode",
    harnessAuthBootstrap: "harness",
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: opencodeManifest.id,
          providers: opencodeManifest.providers,
          setup: opencodeManifest.setup,
          enabledByDefault: opencodeManifest.enabledByDefault,
        },
      ],
    }),
    authProfileStore: authStore({}),
  } satisfies Parameters<typeof prepareAgentRuntimeAuth>[0];

  it("leaves native login to its harness when the manifest only advertises provider setup", () => {
    expect(
      resolveProviderDirectAuthPlanningEvidence("opencode", {}, nativeOpencodeAuth),
    ).toMatchObject({ kind: "setup-provider" });
    const prepared = prepareAgentRuntimeAuth(nativeOpencodeAuth);
    expect(prepared.attempts.map((attempt) => attempt.kind)).toEqual(["implicit"]);
    expect(resolveAgentHarnessPreparedAuthSupport({ plan: prepared.plan })).toEqual({
      source: "none",
    });
    expect(prepared.plan.forwardedAuthProfileId).toBeUndefined();
    expect(prepared.plan.modelRoute).toBeUndefined();
  });

  it("retains setup-provider auth lookup for the built-in runtime", () => {
    const prepared = prepareAgentRuntimeAuth({
      ...nativeOpencodeAuth,
      harnessId: "openclaw",
      harnessRuntime: "openclaw",
      harnessAuthBootstrap: undefined,
    });
    expect(prepared.attempts.map((attempt) => attempt.kind)).toEqual(["direct"]);
    expect(resolveAgentHarnessPreparedAuthSupport({ plan: prepared.plan })).toEqual({
      source: "direct",
      mode: "api-key",
    });
  });

  it("preserves concrete environment and configured credentials for a native selection", () => {
    for (const authored of [
      { env: { OPENCODE_API_KEY: "fixture-opencode-key" } },
      {
        config: {
          models: {
            providers: {
              opencode: {
                baseUrl: "https://opencode.ai/zen/v1",
                apiKey: "fixture-opencode-key",
                models: [],
              },
            },
          },
        },
      },
    ]) {
      const prepared = prepareAgentRuntimeAuth({ ...nativeOpencodeAuth, ...authored });
      expect(prepared.attempts.map((attempt) => attempt.kind)).toEqual(["direct"]);
      expect(resolveAgentHarnessPreparedAuthSupport({ plan: prepared.plan })).toEqual({
        source: "direct",
        mode: "api-key",
      });
    }
  });

  it("preserves an explicit stored profile for native support validation", () => {
    const prepared = prepareAgentRuntimeAuth({
      ...nativeOpencodeAuth,
      authProfileStore: authStore({
        "opencode:user": createApiKeyCredential("opencode", "fixture-opencode-key"),
      }),
      sessionAuthProfileId: "opencode:user",
      sessionAuthProfileSource: "user",
    });
    expect(prepared.attempts[0]?.kind).toBe("profile");
    expect(prepared.plan.forwardedAuthProfileId).toBe("opencode:user");
    expect(resolveAgentHarnessPreparedAuthSupport({ plan: prepared.plan })).toEqual({
      source: "profile",
      mode: "api_key",
    });
  });
});
