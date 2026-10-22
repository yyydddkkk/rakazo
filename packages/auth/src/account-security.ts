import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { bearer } from "better-auth/plugins";

export function accountSecurity(): BetterAuthPlugin {
  return {
    id: "account-security",
    endpoints: {
      accountSecurity: createAuthEndpoint(
        "/account-security",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const credential = await ctx.context.internalAdapter.findCredentialAccount(
            ctx.context.session.user.id,
          );
          return ctx.json({
            hasPassword: Boolean(credential?.password),
            passwordChangeEnabled: true,
          });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/delete-user" || ctx.path === "/delete-user/callback",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/delete-user/callback") throw new APIError("FORBIDDEN");
            const session = await sessionForAuthHook(ctx);
            if (!session) throw new APIError("UNAUTHORIZED");
            if (!ctx.body?.password)
              throw new APIError("BAD_REQUEST", {
                message: "Invalid password",
                code: "INVALID_PASSWORD",
              });
            const credential = await ctx.context.internalAdapter.findCredentialAccount(
              session.user.id,
            );
            if (!credential?.password) throw new APIError("FORBIDDEN");
          }),
        },
      ],
    },
  };
}

/** Raw database session tokens cannot be replayed as bearer credentials. */
export const signedBearer = bearer({ requireSignature: true });

export async function sessionForAuthHook(ctx: Parameters<typeof getSessionFromCtx>[0]) {
  const converted = await signedBearer.hooks.before[0]!.handler({ ...ctx, returnHeaders: false });
  return getSessionFromCtx(
    { ...ctx, headers: converted?.context.headers ?? ctx.headers },
    { disableCookieCache: true },
  );
}
