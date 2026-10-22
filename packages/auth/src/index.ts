import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { displayName, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { accountSecurity, signedBearer } from "./account-security.js";
import { breachedPasswordCheck } from "./breached-password.js";

export type { BootstrapAdminCredentials } from "./bootstrap-admin.js";
export { bootstrapAdmin } from "./bootstrap-admin.js";

export interface AuthEnv {
  /** Opt-in check that calls an outside service. */
  breachedPasswordCheck?: boolean;
  secret: string;
  baseURL: string;
  webOrigin: string;
  extraOrigins?: string[];
  email?: TransactionalEmailProvider;
  logger?: BetterAuthOptions["logger"];
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
  afterDeleteSession?: (session: AuthSession) => Promise<void>;
  afterReplaceSession?: (previous: AuthSession, session: AuthSession) => Promise<void>;
}
type AuthSession = { id: string; userId: string };

export const CLIENT_IP_HEADER = "x-rakazo-client-ip";
export function authRateLimitOptions(nodeEnv = process.env.NODE_ENV) {
  const rule = { window: 15 * 60, max: 10 };
  return {
    enabled: nodeEnv === "production",
    storage: "database" as const,
    customRules: { "/sign-in/email": rule, "/request-password-reset": rule },
  };
}

/** HTTP auth can only use the private bootstrap's existing singleton owner. */
async function isAdmin(prisma: PrismaClient, userId: string): Promise<boolean> {
  const [users, settings] = await Promise.all([
    prisma.user.findMany({ select: { id: true }, take: 2 }),
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    }),
  ]);
  return users.length === 1 && users[0]?.id === userId && settings?.ownerUserId === userId;
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: "Rakazo",
    logger: env.logger,
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    account: { accountLinking: { enabled: false } },
    verification: {
      storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } },
    },
    rateLimit: authRateLimitOptions(),
    advanced: { disableOriginCheck: false, ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          await prisma.$transaction(async (tx) => {
            // Keep the owner reference after deletion so startup cannot create another account.
            await tx.messagingIdentity.deleteMany({ where: { userId: user.id } });
            const memberships = await tx.member.findMany({
              where: { userId: user.id },
              select: { organizationId: true },
            });
            await tx.organization.deleteMany({
              where: { id: { in: memberships.map(({ organizationId }) => organizationId) } },
            });
          });
        },
      },
    },
    plugins: [
      signedBearer,
      accountSecurity(),
      ...(env.breachedPasswordCheck ? [breachedPasswordCheck()] : []),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (isBlockedAuthPath(ctx.path)) throw new APIError("NOT_FOUND");
      }),
      after: createAuthMiddleware(async (ctx) => {
        const redacted = withoutSessionTokens(ctx.path, ctx.context.returned);
        if (redacted) return ctx.json(redacted);
        const signed = withSignedSessionToken(ctx.context, ctx.context.returned);
        if (signed) return ctx.json(signed);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (!(await isAdmin(prisma, session.userId))) throw new APIError("UNAUTHORIZED");
          },
          after: async (session, ctx) => {
            const previous = replacedSession(ctx);
            if (previous) await env.afterReplaceSession?.(previous, session);
          },
        },
        delete: {
          after: async (session, ctx) => {
            if (replacedSession(ctx)?.id !== session.id) await env.afterDeleteSession?.(session);
          },
        },
      },
      user: {
        create: {
          before: async () => {
            throw new APIError("FORBIDDEN");
          },
        },
        update: {
          before: async (user) => ({
            data: {
              ...user,
              ...(user.name !== undefined ? { name: displayName(user.name, "") } : {}),
            },
          }),
        },
      },
    },
  });
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  const name = displayName(user.name, "there");
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  return {
    to: user.email,
    subject: "Reset your Rakazo password",
    text: [
      `Hi ${name},`,
      "",
      "Reset your Rakazo password using this link:",
      resetUrl,
      "",
      "This link expires in one hour. If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>Hi ${safeName},</p><p>Reset your Rakazo password:</p><p><a href="${safeUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Changing the password with revokeOtherSessions deletes every session, then signs the
 * caller in again, so the caller's device stays signed in under a new session.
 */
function replacedSession(
  ctx: { path?: string; context: { session?: { session: AuthSession } | null } } | null,
): AuthSession | undefined {
  return ctx?.path === "/change-password" ? ctx.context.session?.session : undefined;
}

/**
 * A session token is a bearer credential. Session reads describe sessions
 * without handing any of them out; sign-in and sign-up still return the token
 * they just issued. Returns the redacted body, or undefined to keep it.
 */
function withoutSessionTokens(
  path: string,
  returned: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (path === "/list-sessions" && Array.isArray(returned)) {
    return returned.map(withoutToken);
  }
  if (
    (path === "/get-session" || path === "/update-session") &&
    isRecord(returned) &&
    isRecord(returned.session)
  ) {
    return { ...returned, session: withoutToken(returned.session) };
  }
  return undefined;
}

/**
 * A sign-in body carries the new session's raw token, which the bearer plugin
 * refuses. Swap in the signed value from the session cookie, so a native client
 * that keeps the body token stores a bearer that works.
 */
function withSignedSessionToken(
  context: {
    newSession: { session: { token: string } } | null;
    responseHeaders?: Headers;
    authCookies: { sessionToken: { name: string } };
  },
  returned: unknown,
): Record<string, unknown> | undefined {
  const token = context.newSession?.session.token;
  if (!token || !isRecord(returned)) return undefined;
  const cookie = parseSetCookieHeader(context.responseHeaders?.get("set-cookie") ?? "").get(
    context.authCookies.sessionToken.name,
  );
  if (!cookie?.value || cookie["max-age"] === 0) return undefined;
  const signed = decodeURIComponent(cookie.value);
  if (!signed.startsWith(`${token}.`)) return undefined;
  if (returned.token === token) return { ...returned, token: signed };
  if (isRecord(returned.session) && returned.session.token === token) {
    return { ...returned, session: { ...returned.session, token: signed } };
  }
  return undefined;
}

function withoutToken(session: unknown): unknown {
  if (!isRecord(session)) return session;
  const { token: _token, ...rest } = session;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap(loopbackTwinOrigins);
  return [...new Set([...configured, ...twins])];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
export function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

/** Keep removed identity and account-creation routes closed, including future plugin additions. */
export function isBlockedAuthPath(path: string): boolean {
  return [
    "/organization",
    "/passkey",
    "/email-otp",
    "/sign-up",
    "/sign-in/social",
    "/sign-in/oauth2",
    "/sign-in/email-otp",
    "/oauth2",
    "/callback",
    "/link-social",
    "/link-account",
    "/unlink-account",
    "/get-access-token",
    "/refresh-token",
    "/set-password",
    "/change-email",
    "/forget-password/email-otp",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
