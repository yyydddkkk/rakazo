import { randomInt } from "node:crypto";
import type { PrismaClient } from "./client.js";

export interface ProvisionedMessagingIdentity {
  provider: string;
  address: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  created: boolean;
}

export const MESSAGING_LINK_CODE_TTL_MS = 10 * 60 * 1000;

/** No ambiguous glyphs (0/O, 1/I/L, U/V) — the code is typed on a phone. */
const LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const LINK_CODE_LENGTH = 8;

export function formatMessagingLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A message that is exactly one code (dashes/spaces ignored) is a link
 * attempt; anything else is an ordinary message. Returns the canonical form.
 */
export function normalizeMessagingLinkCode(text: string): string | null {
  const normalized = text.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : null;
}

/**
 * Issue the user's single active link code for one of their bots. The code
 * is high-entropy (30^8) and short-lived, so redemption is the only
 * brute-force surface and it is not realistically searchable.
 */
export async function issueMessagingLinkCode(
  prisma: PrismaClient,
  request: { userId: string; spaceId: string; botId: string },
): Promise<{ code: string; expiresAt: Date }> {
  let code = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]!;
  }
  const expiresAt = new Date(Date.now() + MESSAGING_LINK_CODE_TTL_MS);
  // One active code per user: a fresh request supersedes the previous one.
  await prisma.messagingLinkCode.deleteMany({ where: { userId: request.userId } });
  await prisma.messagingLinkCode.create({
    data: { code, ...request, expiresAt },
  });
  return { code, expiresAt };
}

export interface RedeemedMessagingLink {
  identityId: string;
  userId: string;
  spaceId: string;
  botId: string;
  /** Stable per-redemption key for the confirmation outbox row. */
  confirmationKey: string;
}

/**
 * Bind the sending address to the code's user and bot. A fresh address gets
 * a new identity; the code owner's own linked address switches bots. Codes
 * are single-use and never apply to an address someone else owns.
 */
export async function redeemMessagingLinkCode(
  prisma: PrismaClient,
  request: { code: string; provider: string; address: string; dmThreadId: string | null },
): Promise<RedeemedMessagingLink | null> {
  const row = await prisma.messagingLinkCode.findUnique({ where: { code: request.code } });
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      // Single-use: the delete is the claim; a concurrent redemption loses.
      const { count } = await tx.messagingLinkCode.deleteMany({ where: { id: row.id } });
      if (count === 0) return null;
      const existing = await tx.messagingIdentity.findUnique({
        where: { provider_address: { provider: request.provider, address: request.address } },
      });
      if (existing) {
        if (existing.userId !== row.userId) return null;
        await tx.messagingIdentity.update({
          where: { id: existing.id },
          // The identity must follow the bot's space: runs resolve
          // credentials, memory, and approval rules from run.spaceId.
          data: { botId: row.botId, spaceId: row.spaceId, dmThreadId: request.dmThreadId },
        });
        return {
          identityId: existing.id,
          userId: row.userId,
          spaceId: row.spaceId,
          botId: row.botId,
          confirmationKey: `link:${row.id}`,
        };
      }
      const identity = await tx.messagingIdentity.create({
        data: {
          provider: request.provider,
          address: request.address,
          dmThreadId: request.dmThreadId,
          userId: row.userId,
          spaceId: row.spaceId,
          botId: row.botId,
        },
      });
      return {
        identityId: identity.id,
        userId: row.userId,
        spaceId: row.spaceId,
        botId: row.botId,
        confirmationKey: `link:${row.id}`,
      };
    });
  } catch (error) {
    // botId is unique (one chat app per bot) and (provider, address) can race
    // a concurrent inbound; either way the code is spent and the sender can
    // request a fresh one.
    if (isUniqueViolationError(error)) return null;
    throw error;
  }
}

function isUniqueViolationError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
