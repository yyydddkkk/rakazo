import { createLarkAdapter, Domain } from "chat-adapter-lark";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { isVitestRuntime } from "./test-runtime.js";

export interface MessagingEnvironmentValues {
  larkAppId?: string | undefined;
  larkAppSecret?: string | undefined;
  larkVerificationToken?: string | undefined;
  larkEncryptKey?: string | undefined;
  larkDomain?: string | undefined;
}

export function messagingEnvFromProcess(
  env: Record<string, string | undefined>,
): MessagingEnvironmentValues {
  const clean = (value: string | undefined) => value?.trim() || undefined;
  return {
    larkAppId: clean(env.LARK_APP_ID),
    larkAppSecret: clean(env.LARK_APP_SECRET),
    larkVerificationToken: clean(env.LARK_VERIFICATION_TOKEN),
    larkEncryptKey: clean(env.LARK_ENCRYPT_KEY),
    larkDomain: clean(env.LARK_DOMAIN),
  };
}

/** Lark remains a webhook-only, linked direct-message transport. */
export function messagingPlatformsFromEnv(env: MessagingEnvironmentValues): MessagingPlatform[] {
  const platforms: MessagingPlatform[] = [];
  // App ID, secret, and verification token are all required: without the
  // token the adapter accepts unsigned webhook posts. Encrypt key and
  // domain are optional (event encryption / open.feishu.cn vs open.larksuite.com).
  if (env.larkAppId && env.larkAppSecret && env.larkVerificationToken) {
    platforms.push({
      provider: "lark",
      capabilities: { direct: true, groups: false, receipt: null },
      // Webhook-only: ws/long-connection incoming would consume events so
      // the HTTP webhook at /api/v1/messaging/webhook/lark never sees them.
      adapter: createLarkAdapter({
        appId: env.larkAppId,
        appSecret: env.larkAppSecret,
        verificationToken: env.larkVerificationToken,
        incoming: { events: "webhook", callbacks: "webhook" },
        // Explicit defaults prevent the adapter from rereading untrimmed process.env values.
        encryptKey: env.larkEncryptKey ?? "",
        domain: env.larkDomain?.toLowerCase() === "lark" ? Domain.Lark : Domain.Feishu,
      }),
    });
  }

  return platforms;
}

/** Never live under the test runner; tests build surfaces explicitly. */
export function isMessagingEnabled(platforms: MessagingPlatform[]): boolean {
  return platforms.length > 0 && !isVitestRuntime();
}
