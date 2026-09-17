import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../test-utils/plugin-setup-wizard.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard.js";

describe("sensitive setup text inputs", () => {
  it.each([true, false])("keeps configured secrets out of presentation (keep=%s)", async (keep) => {
    const secret = "https://gateway.example.test/callback?token=private";
    const keepPrompt = vi.fn((value: string) => `Keep ${value}?`);
    const initialValue = vi.fn(() => secret);
    const applySet = vi.fn(({ cfg }: { cfg: OpenClawConfig }) => cfg);
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async () => keep),
      text: vi.fn(async () => "https://gateway.example.test/new"),
    });
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin: createChannelTestPluginBase({ id: "synology-chat" }),
      wizard: {
        channel: "synology-chat",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "unset",
          resolveConfigured: () => true,
        },
        credentials: [],
        textInputs: [
          {
            inputKey: "webhookUrl",
            message: "Callback URL",
            sensitive: true,
            currentValue: () => secret,
            keepPrompt,
            initialValue,
            applySet,
          },
        ],
      },
    });
    await runSetupWizardConfigure({ configure: adapter.configure, cfg: {}, prompter });
    expect(keepPrompt).not.toHaveBeenCalled();
    expect(initialValue).not.toHaveBeenCalled();
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Callback URL already configured. Keep it?",
      initialValue: true,
    });
    if (keep) {
      expect(prompter.text).not.toHaveBeenCalled();
      expect(applySet).not.toHaveBeenCalled();
    } else {
      expect(prompter.text).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
      expect(vi.mocked(prompter.text).mock.calls[0]?.[0]).not.toHaveProperty("initialValue");
      expect(applySet).toHaveBeenCalledWith(
        expect.objectContaining({ value: "https://gateway.example.test/new" }),
      );
    }
  });
});
