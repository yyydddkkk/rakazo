import { createHmac } from "node:crypto";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { recordSecurityEvent } from "@rakazo/db";
import { hashPassword } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER, createAuth } from "./index.js";

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", () => ({
  bootstrapUserSpace: vi.fn(),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const password = "offline-password-1234";
const secret = "offline-auth-secret-at-least-32-characters";
const baseURL = "http://auth.example.test";
const webOrigin = "http://web.example.test";

async function fixture({ breachedPasswordCheck = false } = {}) {
  const now = new Date();
  const data: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: "admin",
        name: "Admin",
        email: "admin@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    account: [
      {
        id: "credential",
        userId: "admin",
        providerId: "credential",
        accountId: "admin",
        password: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      },
    ],
    session: [],
    verification: [],
  };
  const prisma = {
    authData: data,
    user: { findMany: vi.fn(async () => data.user!.map(({ id }) => ({ id }))) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "admin" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    member: { findMany: vi.fn(async () => [{ organizationId: "space" }]) },
    organization: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
  };
  const messages: TransactionalEmail[] = [];
  const log = vi.fn();
  const afterDeleteSession = vi.fn(async () => undefined);
  const afterReplaceSession = vi.fn(async () => undefined);
  const auth = createAuth(prisma as never, {
    secret,
    baseURL,
    webOrigin,
    breachedPasswordCheck,
    logger: { level: "error", log },
    afterDeleteSession,
    afterReplaceSession,
    email: {
      describe: () => ({
        id: "offline",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { transactional: true },
      }),
      send: async (message) => {
        messages.push(message);
      },
    },
  });
  const request = (
    path: string,
    body?: unknown,
    token?: string,
    extraHeaders?: Record<string, string>,
  ) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const signin = () => request("/sign-in/email", { email: "admin@example.test", password });
  return {
    auth,
    data,
    prisma,
    messages,
    request,
    signin,
    log,
    afterDeleteSession,
    afterReplaceSession,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("private administrator authentication", () => {
  it("signs in with the existing credential and rejects a wrong password", async () => {
    const f = await fixture();
    expect((await f.signin()).status).toBe(200);
    expect(
      (
        await f.request("/sign-in/email", {
          email: "admin@example.test",
          password: "wrong-password",
        })
      ).status,
    ).toBe(401);
  });
  it.each([
    "/sign-up/email",
    "/organization/create",
    "/sign-in/social",
    "/sign-in/oauth2",
    "/email-otp/send-verification-otp",
    "/sign-in/email-otp",
    "/passkey/generate-authenticate-options",
  ])("closes %s without creating users", async (path) => {
    const f = await fixture();
    expect(
      (
        await f.request(path, {
          email: "other@example.test",
          password,
          name: "Other",
          provider: "oidc",
          type: "sign-in",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.data.user).toHaveLength(1);
    expect(f.data.session).toHaveLength(0);
  });
  it("rejects signin if singleton ownership no longer holds", async () => {
    const f = await fixture();
    f.data.user!.push({ id: "unexpected" });
    expect((await f.signin()).status).toBe(401);
    expect(f.data.session).toHaveLength(0);
  });
  it("does not permit even internal Better Auth user creation", async () => {
    const f = await fixture();
    const ctx = await f.auth.$context;
    await expect(
      ctx.internalAdapter.createUser(
        { email: "other@example.test", name: "Other", emailVerified: true },
        { method: "email" },
      ),
    ).rejects.toThrow();
    expect(f.data.user).toHaveLength(1);
  });
});

describe("session and account security", () => {
  it("records the API's resolved client address without trusting forwarding headers", async () => {
    const f = await fixture();
    const response = await f.request(
      "/sign-in/email",
      { email: "admin@example.test", password },
      undefined,
      { [CLIENT_IP_HEADER]: "192.0.2.1", "x-forwarded-for": "198.51.100.2" },
    );
    expect(response.status).toBe(200);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "auth.sign_in", ip: "192.0.2.1" }),
    );
  });
  it("signs returned bearer tokens and never exposes tokens from session reads", async () => {
    const f = await fixture();
    const { token } = (await (await f.signin()).json()) as { token: string };
    const raw = String(f.data.session![0]!.token);
    expect(token).toBe(`${raw}.${createHmac("sha256", secret).update(raw).digest("base64")}`);
    expect(await (await f.request("/get-session", undefined, raw)).json()).toBeNull();
    const session = (await (await f.request("/get-session", undefined, token)).json()) as {
      session: object;
    };
    expect(session.session).not.toHaveProperty("token");
    const sessions = (await (
      await f.request("/list-sessions", undefined, token)
    ).json()) as object[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toHaveProperty("token");
  });
  it("requires the current password for account deletion", async () => {
    const f = await fixture();
    const { token } = (await (await f.signin()).json()) as { token: string };
    expect((await f.request("/delete-user", {}, token)).status).toBe(400);
    expect((await f.request("/delete-user", { password: "incorrect" }, token)).status).toBe(400);
    expect(f.data.user).toHaveLength(1);
    expect((await f.request("/delete-user", { password }, token)).status).toBe(200);
    expect(f.data.user).toHaveLength(0);
  });
  it("replaces the current session and revokes other sessions on password change", async () => {
    const f = await fixture();
    const { token } = (await (await f.signin()).json()) as { token: string };
    const { token: other } = (await (await f.signin()).json()) as { token: string };
    const response = await f.request(
      "/change-password",
      {
        currentPassword: password,
        newPassword: "changed-password-1234",
        revokeOtherSessions: true,
      },
      token,
    );
    expect(response.status).toBe(200);
    expect(f.afterReplaceSession).toHaveBeenCalledOnce();
    expect(f.data.session).toHaveLength(1);
    expect(await (await f.request("/get-session", undefined, other)).json()).toBeNull();
    expect((await f.signin()).status).toBe(401);
  });
  it("accepts a reset token issued before hashed storage was enabled", async () => {
    const f = await fixture();
    const token = "legacy-reset-token";
    f.data.verification!.push({
      id: "legacy-reset",
      identifier: `reset-password:${token}`,
      value: "admin",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      (await f.request("/reset-password", { token, newPassword: "changed-password-1234" })).status,
    ).toBe(200);
    expect(f.data.verification).toHaveLength(0);
  });
  it("answers unknown password recovery without sending email", async () => {
    const f = await fixture();
    expect(
      (
        await f.request("/request-password-reset", {
          email: "unknown@example.test",
          redirectTo: `${webOrigin}/reset-password`,
        })
      ).status,
    ).toBe(200);
    expect(f.messages).toHaveLength(0);
  });
  it("reports only password capabilities and ends sessions through sign-out", async () => {
    const f = await fixture();
    const { token } = (await (await f.signin()).json()) as { token: string };
    expect(await (await f.request("/account-security", undefined, token)).json()).toEqual({
      hasPassword: true,
      passwordChangeEnabled: true,
    });
    expect((await f.request("/sign-out", {}, token)).status).toBe(200);
    expect(f.data.session).toHaveLength(0);
    expect(f.afterDeleteSession).toHaveBeenCalledOnce();
    expect(recordSecurityEvent).toHaveBeenCalledWith({ type: "auth.sign_out", userId: "admin" });
  });
  it("rejects account mutation from an untrusted origin", async () => {
    const f = await fixture();
    expect(
      (
        await f.request("/sign-in/email", { email: "admin@example.test", password }, undefined, {
          origin: "http://untrusted.example.test",
          cookie: "session=untrusted",
        })
      ).status,
    ).toBe(403);
    expect(f.data.session).toHaveLength(0);
  });
  it("hashes reset tokens, consumes them once, and revokes existing sessions", async () => {
    const f = await fixture();
    await f.signin();
    expect(
      (
        await f.request("/request-password-reset", {
          email: "admin@example.test",
          redirectTo: `${webOrigin}/reset-password`,
        })
      ).status,
    ).toBe(200);
    const url = new URL(f.messages[0]!.text.match(/http:\/\/\S+/)![0]);
    const token = url.pathname.split("/").at(-1)!;
    expect(JSON.stringify(f.data.verification)).not.toContain(token);
    const body = { token, newPassword: "reset-password-1234" };
    expect((await f.request("/reset-password", body)).status).toBe(200);
    expect(f.data.session).toHaveLength(0);
    expect((await f.request("/reset-password", body)).status).toBe(400);
    expect(
      (
        await f.request("/sign-in/email", {
          email: "admin@example.test",
          password: body.newPassword,
        })
      ).status,
    ).toBe(200);
  });
});
