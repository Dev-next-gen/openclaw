import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway, callGatewayCli } from "./call.js";

describe("operator CLI message input", () => {
  const readConfig = vi.fn((): never => {
    throw new Error("configuration resolution reached");
  });
  beforeEach(() => {
    readConfig.mockClear();
    vi.stubEnv("OPENCLAW_SHELL", "exec");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["sessions.send", "sessions.steer", "chat.send", "agent"])(
    "refuses direct callGatewayCli %s before reading configuration or credentials",
    async (method) => {
      const options = {
        method,
        scopes: ["operator.admin" as const],
        get config() {
          return readConfig();
        },
      };
      await expect(callGatewayCli(options)).rejects.toThrow(/inter-session attribution/);
      expect(readConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.BACKEND },
    { clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT, mode: GATEWAY_CLIENT_MODES.CLI },
  ])("keeps mixed CLI identities on the guarded entry: %j", async (identity) => {
    const options = {
      method: "sessions.send",
      ...identity,
      get config() {
        return readConfig();
      },
    };
    await expect(callGateway(options)).rejects.toThrow(/inter-session attribution/);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("does not classify omitted backend defaults as operator CLI", async () => {
    await expect(
      callGateway({
        method: "agent",
        get config() {
          return readConfig();
        },
      }),
    ).rejects.toThrow("configuration resolution reached");
    expect(readConfig).toHaveBeenCalledOnce();
  });
});
