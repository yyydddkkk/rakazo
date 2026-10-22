import { Domain } from "chat-adapter-lark";
import { describe, expect, it } from "vitest";
import {
  isMessagingEnabled,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
} from "./messaging-platforms.js";

const credentials = {
  larkAppId: "cli-fixture",
  larkAppSecret: "fixture-secret",
  larkVerificationToken: "fixture-verification",
};

describe("Lark messaging composition", () => {
  it("requires all verification credentials before mounting", () => {
    expect(messagingPlatformsFromEnv({})).toEqual([]);
    for (const key of Object.keys(credentials)) {
      expect(messagingPlatformsFromEnv({ ...credentials, [key]: undefined })).toEqual([]);
    }
    expect(messagingPlatformsFromEnv(credentials)).toEqual([
      expect.objectContaining({
        provider: "lark",
        capabilities: { direct: true, groups: false, receipt: null },
      }),
    ]);
  });

  it("normalizes only the retained connection settings", () => {
    expect(
      messagingEnvFromProcess({
        LARK_APP_ID: " cli-fixture ",
        LARK_APP_SECRET: " secret ",
        LARK_VERIFICATION_TOKEN: " token ",
        LARK_ENCRYPT_KEY: " ",
        LARK_DOMAIN: " lark ",
      }),
    ).toEqual({
      larkAppId: "cli-fixture",
      larkAppSecret: "secret",
      larkVerificationToken: "token",
      larkEncryptKey: undefined,
      larkDomain: "lark",
    });
  });

  it("uses the configured domain without opening a long connection", () => {
    for (const [domain, expected] of [
      ["lark", Domain.Lark],
      ["feishu", Domain.Feishu],
    ] as const) {
      const [platform] = messagingPlatformsFromEnv({ ...credentials, larkDomain: domain });
      expect(platform?.adapter).toMatchObject({
        name: "lark",
        config: { domain: expected, incoming: { events: "webhook", callbacks: "webhook" } },
      });
      // Constructing a verified webhook adapter never starts background polling.
      expect(platform?.capabilities.groups).toBe(false);
    }
  });

  it("never enables live transport implicitly under the test runner", () => {
    expect(isMessagingEnabled(messagingPlatformsFromEnv(credentials))).toBe(false);
  });
});
