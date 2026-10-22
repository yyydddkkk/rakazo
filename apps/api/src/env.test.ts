import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("defaults uploads to 10 MiB and parses a configured limit", () => {
    expect(loadEnv(base).maxUploadSizeBytes).toBe(10 * 1024 * 1024);
    expect(loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: "" }).maxUploadSizeBytes).toBe(10 * 1024 * 1024);
    expect(loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: " 25 " }).maxUploadSizeBytes).toBe(
      25 * 1024 * 1024,
    );
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "1e3", "0x10", "9007199254740991"])(
    "rejects invalid upload limit %s",
    (value) => {
      expect(() => loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: value })).toThrow("MAX_UPLOAD_SIZE_MB");
    },
  );
  it("leaves one-click app connections off unless a Composio key is set", () => {
    expect(loadEnv(base).composioApiKey).toBeUndefined();
    expect(loadEnv({ ...base, COMPOSIO_API_KEY: "fake-composio-key" }).composioApiKey).toBe(
      "fake-composio-key",
    );
  });
  it("keeps the ticket board off unless explicitly enabled", () => {
    expect(loadEnv(base).ticketBoardEnabled).toBe(false);
    for (const value of ["false", "1", ""])
      expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: value }).ticketBoardEnabled).toBe(false);
    expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: "true" }).ticketBoardEnabled).toBe(true);
  });
  it("defaults the product path to Pi, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("pi");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
    expect(env.apiHost).toBe("127.0.0.1");
    expect(env.nodeEnv).toBe("test");
  });

  it("defaults Pi JSONL session recording to off", () => {
    expect(loadEnv(base).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "false" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "1" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "true" }).piSessionRecording).toBe(true);
  });

  it("keeps explicit emulator settings for pnpm test", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });

  it("loads an optional integrations catalog mirror", () => {
    expect(loadEnv(base).integrationsCatalogUrl).toBeUndefined();
    expect(
      loadEnv({ ...base, INTEGRATIONS_CATALOG_URL: " https://catalog.example.test/feed " })
        .integrationsCatalogUrl,
    ).toBe("https://catalog.example.test/feed");
  });

  it("keeps computers disabled when requested", () => {
    expect(loadEnv({ ...base, SANDBOX_PROVIDER: "none" }).sandboxProvider).toBe("none");
    expect(loadEnv({ ...base, SANDBOX_PROVIDER: "" }).sandboxProvider).toBe("none");
  });

  it("loads provider-neutral external conversation settings", () => {
    expect(
      loadEnv({
        ...base,
        EXTERNAL_CONVERSATION_BOT_ID: " bot-id ",
        EXTERNAL_CONVERSATION_JUDGE_PROVIDER: "local",
        EXTERNAL_CONVERSATION_JUDGE_MODEL: "judge-model",
      }),
    ).toMatchObject({
      externalConversationBotId: "bot-id",
      externalConversationJudgeProvider: "local",
      externalConversationJudgeModel: "judge-model",
    });
  });

  it("throws when production omits secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production uses placeholder secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-secret-change-me-please-32chars",
        ENCRYPTION_KEY: "real-encryption-key-value",
        SANDBOX_SUPERVISOR_TOKEN: "real-supervisor-token-with-enough-length",
        SCREEN_PROXY_SECRET: "real-screen-proxy-secret-with-enough-length",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("loads real secrets in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "none",
      API_HOST: "0.0.0.0",
    });
    expect(env.authSecret).toBe("prod-auth-secret-with-enough-length");
    expect(env.encryptionKey).toBe("prod-encryption-key-with-enough-length");
    expect(env.sandboxSupervisorToken).toBeUndefined();
    expect(env.screenProxySecret).toBe("prod-screen-proxy-secret-with-enough-length");
    expect(env.apiHost).toBe("0.0.0.0");
  });

  it("encrypts content on servers by default and fails startup on an invalid switch", () => {
    const production = {
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "none",
    };
    expect(loadEnv(production).contentEncryption).toBe(true);
    expect(loadEnv({ ...production, CONTENT_ENCRYPTION: "off" }).contentEncryption).toBe(false);
    expect(
      loadEnv({ DATABASE_URL: base.DATABASE_URL, NODE_ENV: "development" }).contentEncryption,
    ).toBe(false);
    expect(() => loadEnv({ ...production, CONTENT_ENCRYPTION: "maybe" })).toThrow(
      /CONTENT_ENCRYPTION must be "on" or "off"/,
    );
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "docker",
    });
    expect(env.sandboxProvider).toBe("none");
    expect(env.sandboxSupervisorToken).toBeUndefined();
  });

  it("requires a dedicated supervisor token when Docker stays selected", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "too-short",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("exposes a deployed git revision when GIT_SHA is set", () => {
    expect(loadEnv(base).gitSha).toBeUndefined();
    expect(loadEnv({ ...base, GIT_SHA: "  3c6e209  " }).gitSha).toBe("3c6e209");
    expect(loadEnv({ ...base, RAKAZO_GIT_SHA: "abc1234" }).gitSha).toBe("abc1234");
  });

  it("loads per-client minimum builds and refuses a malformed one", () => {
    expect(loadEnv(base).minimumClientBuilds).toEqual({});
    expect(
      loadEnv({ ...base, RAKAZO_MIN_CLIENT_BUILD: "web=20261022093015" }).minimumClientBuilds,
    ).toEqual({ web: "20261022093015" });
    expect(() => loadEnv({ ...base, RAKAZO_MIN_CLIENT_BUILD: "latest" })).toThrow(
      /RAKAZO_MIN_CLIENT_BUILD/,
    );
  });

  it("loads SMTP configuration and keeps the email emulator out of production", () => {
    expect(
      loadEnv({
        ...base,
        SMTP_URL: " smtps://user:secret@smtp.example.test:465 ",
        EMAIL_FROM: " Rakazo <no-reply@example.test> ",
        EMAIL_EMULATOR: "true",
      }),
    ).toMatchObject({
      smtpUrl: "smtps://user:secret@smtp.example.test:465",
      emailFrom: "Rakazo <no-reply@example.test>",
      emailEmulator: true,
    });
    expect(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "none",
        EMAIL_EMULATOR: "true",
      }).emailEmulator,
    ).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: "development" }).nodeEnv).toBe("development");
  });

  it("defaults the remote MCP private-endpoint escape to off", () => {
    expect(loadEnv(base).mcpAllowPrivateEndpoint).toBe(false);
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "true" }).mcpAllowPrivateEndpoint).toBe(
      true,
    );
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "1" }).mcpAllowPrivateEndpoint).toBe(
      false,
    );
  });
});

describe("administrator credentials", () => {
  it("allows existing installations to omit bootstrap credentials", () => {
    expect(loadEnv(base)).toMatchObject({ adminEmail: undefined, adminPassword: undefined });
  });
  it("reads credentials without changing password whitespace", () => {
    expect(
      loadEnv({
        ...base,
        RAKAZO_ADMIN_EMAIL: " admin@example.test ",
        RAKAZO_ADMIN_PASSWORD: " password-with-spaces ",
      }),
    ).toMatchObject({ adminEmail: "admin@example.test", adminPassword: " password-with-spaces " });
  });
  it("validates the opt-in breach check", () => {
    expect(() => loadEnv({ ...base, AUTH_BREACHED_PASSWORD_CHECK_ENABLED: "invalid" })).toThrow(
      "AUTH_BREACHED_PASSWORD_CHECK_ENABLED",
    );
    expect(
      loadEnv({ ...base, AUTH_BREACHED_PASSWORD_CHECK_ENABLED: "true" }).breachedPasswordCheck,
    ).toBe(true);
  });
});
