// Feishu tests cover tool account plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveFeishuToolAccount } from "./tool-account.js";

describe("resolveFeishuToolAccount", () => {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: "ops",
        appId: "base-app-id",
        appSecret: "base-app-secret", // pragma: allowlist secret
        accounts: {
          ops: {
            enabled: true,
            appId: "ops-app-id",
            appSecret: "ops-app-secret", // pragma: allowlist secret
          },
          work: {
            enabled: true,
            appId: "work-app-id",
            appSecret: "work-app-secret", // pragma: allowlist secret
          },
        },
      },
    },
  };

  it("prefers the active contextual account over configured defaultAccount", () => {
    const resolved = resolveFeishuToolAccount({
      api: { config: cfg },
      requiredTool: { family: "wiki", label: "Wiki" },
      defaultAccountId: "work",
    });

    expect(resolved.accountId).toBe("work");
  });

  it("falls back to configured defaultAccount when there is no contextual account", () => {
    const resolved = resolveFeishuToolAccount({
      api: { config: cfg },
      requiredTool: { family: "wiki", label: "Wiki" },
    });

    expect(resolved.accountId).toBe("ops");
  });
  it("skips disabled configured defaults without reactivating credentials", () => {
    const resolved = resolveFeishuToolAccount({
      api: {
        config: {
          channels: {
            feishu: {
              ...cfg.channels.feishu,
              accounts: {
                ...cfg.channels.feishu.accounts,
                ops: { ...cfg.channels.feishu.accounts.ops, enabled: false },
              },
            },
          },
        },
      },
      requiredTool: { family: "wiki", label: "Wiki" },
    });
    expect(resolved.accountId).not.toBe("ops");
    expect(resolved.enabled).toBe(true);
  });
  it("rejects a disabled channel instead of falling back to its credentials", () => {
    expect(() =>
      resolveFeishuToolAccount({
        api: { config: { channels: { feishu: { ...cfg.channels.feishu, enabled: false } } } },
        requiredTool: { family: "wiki", label: "Wiki" },
      }),
    ).toThrow("No usable Feishu account has Wiki tools enabled");
  });
});
