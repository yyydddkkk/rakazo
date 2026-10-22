import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authRateLimitOptions,
  buildTrustedOrigins,
  createAuth,
  isBlockedAuthPath,
  passwordResetEmail,
} from "./index.js";

describe("auth policy", () => {
  it("closes every organization plugin route", () => {
    for (const path of [
      "/organization/delete",
      "/organization/update",
      "/organization/leave",
      "/organization/create",
      "/organization/invite-member",
      "/organization/cancel-invitation",
      "/organization/set-active",
      "/organization/list",
      "/organization/create-team",
      "/organization/some-future-route",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(true);
    }
  });

  it("keeps the account routes the apps call", () => {
    for (const path of [
      "/sign-in/email",
      "/sign-out",
      "/get-session",
      "/change-password",
      "/request-password-reset",
      "/reset-password",
      "/delete-user",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(false);
    }
  });
});

describe("authRateLimitOptions", () => {
  it("caps credential routes at 10 attempts per 15 minutes in a shared table", () => {
    expect(authRateLimitOptions("production")).toEqual({
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 15 * 60, max: 10 },
        "/request-password-reset": { window: 15 * 60, max: 10 },
      },
    });
  });

  it("stays off outside production so the test suite can sign in", () => {
    expect(authRateLimitOptions("test").enabled).toBe(false);
  });
});

describe("buildTrustedOrigins", () => {
  it("adds the localhost twin for a 127.0.0.1 web origin", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "http://127.0.0.1:5173",
        baseURL: "http://127.0.0.1:5173",
      }),
    ).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
  });

  it("keeps extraOrigins and does not twin non-loopback hosts", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "https://app.example.test",
        baseURL: "https://api.example.test",
        extraOrigins: ["https://extra.example.test"],
      }),
    ).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "https://extra.example.test",
    ]);
  });
});

describe("passwordResetEmail", () => {
  it("keeps the reset URL in text and escapes user-controlled HTML", () => {
    const message = passwordResetEmail(
      { id: "user-1", email: "ada@example.test", name: '<Ada & "team">' },
      "https://rakazo.test/reset-password?token=secret&next=1",
    );

    expect(message).toMatchObject({
      to: "ada@example.test",
      subject: "Reset your Rakazo password",
    });
    expect(message.text).toContain("https://rakazo.test/reset-password?token=secret&next=1");
    expect(message.html).toContain("&lt;Ada &amp; &quot;team&quot;&gt;");
    expect(message.html).toContain("token=secret&amp;next=1");
    expect(message.html).not.toContain('<Ada & "team">');
  });
});

describe("stored account names", () => {
  const auth = createAuth({} as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL: "https://api.example.test",
    webOrigin: "https://app.example.test",
  });
  it.each(["", " ", "__TestTok1__", "550e8400-e29b-41d4-a716-446655440000"])(
    "normalizes unusable names on updates: %s",
    async (name) => {
      const hooks = auth.options.databaseHooks!.user!;
      expect(await hooks.update!.before!({ name })).toMatchObject({ data: { name: "" } });
    },
  );
  it("preserves real names and does not change names during unrelated updates", async () => {
    const hook = auth.options.databaseHooks!.user!.update!.before!;
    expect(await hook({ name: " 李雷 " })).toMatchObject({ data: { name: "李雷" } });
    const result = await hook({ emailVerified: true });
    expect(result).toEqual({ data: { emailVerified: true } });
  });
});

describe("bearer sessions", () => {
  const secret = "offline-auth-secret-at-least-32-characters";
  const token = "fakeSessionToken0123456789abcdef";

  function authWithSessionLookups() {
    const lookups: unknown[] = [];
    const model = new Proxy(
      {},
      {
        get: () =>
          vi.fn(async (query: unknown) => {
            lookups.push(query);
            return null;
          }),
      },
    );
    const prisma = new Proxy({}, { get: (_target, name) => (name === "then" ? undefined : model) });
    const auth = createAuth(prisma as never, {
      secret,
      baseURL: "https://api.example.test",
      webOrigin: "https://app.example.test",
    });
    return { auth, lookups };
  }

  function signed(value: string, key = secret) {
    return `${value}.${createHmac("sha256", key).update(value).digest("base64")}`;
  }

  it.each([
    ["a raw session token", token],
    ["a token signed with another key", signed(token, "another-secret-of-at-least-32-chars")],
  ])("never looks up a session for %s", async (_label, bearer) => {
    const { auth, lookups } = authWithSessionLookups();
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${bearer}` }),
    });
    expect(session).toBeNull();
    expect(JSON.stringify(lookups)).not.toContain(token);
  });

  it.each([
    ["raw", signed(token)],
    ["URL-encoded", encodeURIComponent(signed(token))],
  ])("looks up the session for a %s signed token", async (_label, bearer) => {
    const { auth, lookups } = authWithSessionLookups();
    await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${bearer}` }) });
    expect(JSON.stringify(lookups)).toContain(token);
  });
});
