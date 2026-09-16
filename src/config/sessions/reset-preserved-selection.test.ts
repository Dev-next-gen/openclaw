import { describe, expect, it } from "vitest";
import { resolveResetPreservedSelection } from "./reset-preserved-selection.js";

describe("resolveResetPreservedSelection", () => {
  it("does not stamp legacy raw aliases as resolved during reset", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy",
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "sonnet",
        },
      }),
    ).toEqual({
      providerOverride: "anthropic",
      modelOverride: "sonnet",
      modelOverrideSource: "user",
    });
  });

  it("preserves canonical route provenance", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "canonical",
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      }),
    ).toMatchObject({
      modelOverride: "claude-sonnet-4-6",
      modelOverrideRouteResolution: "resolved",
    });
  });

  it.each(["user", undefined] as const)(
    "preserves the runtime with a user model selection (%s)",
    (modelOverrideSource) => {
      expect(
        resolveResetPreservedSelection({
          entry: {
            sessionId: "native-choice",
            updatedAt: 1,
            providerOverride: "provider-a",
            modelOverride: "opaque/model",
            modelOverrideSource,
            agentRuntimeOverride: "native-runtime",
            agentHarnessId: "previous-runtime",
            cliSessionIds: { "previous-runtime": "old-native-session" },
          },
        }),
      ).toEqual({
        providerOverride: "provider-a",
        modelOverride: "opaque/model",
        modelOverrideSource: "user",
        agentRuntimeOverride: "native-runtime",
      });
    },
  );

  it("drops a runtime attached to an automatic fallback", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "automatic-choice",
          updatedAt: 1,
          providerOverride: "provider-a",
          modelOverride: "opaque/model",
          modelOverrideSource: "auto",
          agentRuntimeOverride: "native-runtime",
        },
      }),
    ).toEqual({});
  });

  it("preserves an explicit configured-default selection", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "explicit-default",
          updatedAt: 1,
          modelOverrideSource: "default",
        },
      }),
    ).toEqual({ modelOverrideSource: "default" });
  });

  it("preserves legacy user auth pins while dropping legacy automatic pins", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy-user",
          updatedAt: 1,
          authProfileOverride: "openai:work",
        },
      }),
    ).toEqual({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });

    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy-auto",
          updatedAt: 1,
          authProfileOverride: "openai:fallback",
          authProfileOverrideCompactionCount: 0,
        },
      }),
    ).toEqual({});
  });
});
