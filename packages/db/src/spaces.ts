import { randomUUID } from "node:crypto";
import { displayName } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** One owner cannot fan out unbounded boundaries. */
const MAX_SPACES_PER_MEMBER = 32;

export class SpaceLimitError extends Error {
  constructor() {
    super("Space limit reached");
    this.name = "SpaceLimitError";
  }
}

export class InvalidSpaceNameError extends Error {
  constructor() {
    super("Space name must be readable and between 1 and 60 characters");
    this.name = "InvalidSpaceNameError";
  }
}

export class SpaceNotFoundError extends Error {
  constructor() {
    super("Space not found");
    this.name = "SpaceNotFoundError";
  }
}

export class CannotDeleteDefaultSpaceError extends Error {
  constructor() {
    super("The default space cannot be deleted");
    this.name = "CannotDeleteDefaultSpaceError";
  }
}

export class CannotDeleteLastSpaceError extends Error {
  constructor() {
    super("The last remaining space cannot be deleted");
    this.name = "CannotDeleteLastSpaceError";
  }
}

export class SpaceNotEmptyError extends Error {
  constructor() {
    super("Delete its bots and groups first");
    this.name = "SpaceNotEmptyError";
  }
}

export class SpaceDeletionInProgressError extends Error {
  constructor() {
    super("Space deletion is already in progress");
    this.name = "SpaceDeletionInProgressError";
  }
}

export const SPACE_DELETION_CLAIM_TIMEOUT_MS = 5 * 60_000;

/** Serialize content creation with the empty-space deletion claim. */
export async function lockSpaceForContentCreation(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string }> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))::text AS "lock"
  `);
  const membership = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: {
      organizationId: true,
      space: { select: { deletingAt: true } },
    },
  });
  if (!membership) throw new IsolationError();
  if (membership.space.deletingAt) throw new SpaceDeletionInProgressError();
  return { organizationId: membership.organizationId };
}

async function lockSpaceDeletion(tx: Prisma.TransactionClient, spaceId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))::text AS "lock"
  `);
}

function normalizeSpaceName(name: string): string {
  const trimmed = name.trim();
  if (!displayName(trimmed, "") || trimmed.length > 60) throw new InvalidSpaceNameError();
  return trimmed;
}

/** Create another Space for the owner in their Organization. */
export async function createSpaceForMember(
  prisma: PrismaClient,
  input: { currentSpaceId: string; userId: string; name: string },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  const spaceId = randomUUID();
  const createdAt = new Date();

  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const current = await tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: input.currentSpaceId, userId: input.userId } },
          select: { organizationId: true },
        });
        if (!current) throw new IsolationError();
        const count = await tx.spaceMember.count({
          where: { userId: input.userId, organizationId: current.organizationId },
        });
        if (count >= MAX_SPACES_PER_MEMBER) throw new SpaceLimitError();
        await tx.space.create({
          data: {
            id: spaceId,
            organizationId: current.organizationId,
            name,
            createdByUserId: input.userId,
            createdAt,
          },
        });
        await tx.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId,
            organizationId: current.organizationId,
            userId: input.userId,
            role: "owner",
            createdAt,
          },
        });
        await tx.memoryDocument.create({
          data: {
            spaceId,
            userId: input.userId,
            scope: "user",
            path: "MEMORY.md",
            content:
              "# Space memory\n\nPreferences and context kept within this space live here.\n",
          },
        });
        // Model connections belong to the owner; the new space starts on the same choices.
        const preferences = await tx.spaceModelPreference.findMany({
          where: { spaceId: input.currentSpaceId, userId: input.userId },
        });
        if (preferences.length) {
          await tx.spaceModelPreference.createMany({
            data: preferences.map((preference) => ({
              spaceId,
              userId: input.userId,
              credentialId: preference.credentialId,
              modelId: preference.modelId,
              thinkingLevel: preference.thinkingLevel,
              isDefault: preference.isDefault,
              createdAt,
              updatedAt: createdAt,
            })),
          });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  return { id: spaceId, name };
}

type SpaceTargetInput = {
  currentSpaceId: string;
  userId: string;
  spaceId: string;
};

type ClaimedSpaceDeleteInput = SpaceTargetInput & { claimId: string };

type SpaceDeleteDb = Pick<PrismaClient, "spaceMember" | "bot" | "chatGroup" | "computer">;

async function loadOwnedSpace(db: Pick<PrismaClient, "spaceMember">, input: SpaceTargetInput) {
  const currentMembership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.currentSpaceId, userId: input.userId } },
    select: { organizationId: true },
  });
  if (!currentMembership) throw new IsolationError();
  const targetMembership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: {
      organizationId: true,
      space: { select: { isDefault: true, deletingAt: true } },
    },
  });
  if (!targetMembership || targetMembership.organizationId !== currentMembership.organizationId) {
    throw new SpaceNotFoundError();
  }
  return {
    organizationId: currentMembership.organizationId,
    isDefault: targetMembership.space.isDefault,
    deletingAt: targetMembership.space.deletingAt,
  };
}

async function assertEmptySpaceDeletable(db: SpaceDeleteDb, input: SpaceTargetInput) {
  const owned = await loadOwnedSpace(db, input);
  if (owned.isDefault) throw new CannotDeleteDefaultSpaceError();
  const memberships = await db.spaceMember.findMany({
    where: { userId: input.userId, organizationId: owned.organizationId },
    select: { spaceId: true, space: { select: { isDefault: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length <= 1) throw new CannotDeleteLastSpaceError();
  const [botCount, groupCount, computers] = await Promise.all([
    db.bot.count({ where: { spaceId: input.spaceId } }),
    db.chatGroup.count({ where: { spaceId: input.spaceId } }),
    db.computer.findMany({
      where: { spaceId: input.spaceId, providerRef: { not: null } },
      select: { homeKey: true, kind: true, providerRef: true },
    }),
  ]);
  if (botCount > 0 || groupCount > 0) throw new SpaceNotEmptyError();
  return {
    memberships,
    computers: computers.flatMap((computer) =>
      computer.providerRef
        ? [{ homeKey: computer.homeKey, kind: computer.kind, providerRef: computer.providerRef }]
        : [],
    ),
  };
}

/** Claim an empty Space before external teardown.
 *
 * Content creation takes the same advisory lock and rejects a claimed Space,
 * so no bot or group can appear after this emptiness check. A stale claim may
 * be retried after five minutes if a process exits. Takeover is safe because
 * provider destroy is idempotent (missing remotes succeed), every worker
 * verifies its claim token before and after each destroy, provider-handle
 * clearing is conditioned on the claim token, and no worker releases its
 * claim after external teardown starts — so content can never be unblocked
 * while an old destroy may still be in flight. */
export async function claimEmptySpaceDeletionForMember(
  prisma: PrismaClient,
  input: SpaceTargetInput,
): Promise<{
  claimId: string;
  recovered: boolean;
  computers: Array<{ homeKey: string; kind: string; providerRef: string }>;
}> {
  const claimId = randomUUID();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const planned = await assertEmptySpaceDeletable(tx, input);
        const lifecycle = await tx.space.findUnique({
          where: { id: input.spaceId },
          select: { deletingAt: true },
        });
        const claimedBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
        const claimed = await tx.space.updateMany({
          where: {
            id: input.spaceId,
            OR: [{ deletingAt: null }, { deletingAt: { lt: claimedBefore } }],
          },
          data: { deletingAt: new Date(), deletionClaimId: claimId },
        });
        if (claimed.count === 0) throw new SpaceDeletionInProgressError();
        return {
          claimId,
          recovered: Boolean(lifecycle?.deletingAt),
          computers: planned.computers,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Renew an active claim while provider teardown is in flight. */
export async function renewSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<boolean> {
  const renewed = await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId } },
    },
    data: { deletingAt: new Date() },
  });
  return renewed.count === 1;
}

/** Release only this caller's deletion claim after teardown or validation fails. */
export async function releaseSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<void> {
  await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId } },
    },
    data: { deletingAt: null, deletionClaimId: null },
  });
}

/** Delete an empty, non-default Space.
 *
 * Only empty spaces: bots (including archived) and groups would otherwise
 * orphan sandbox computers and files that `destroyBot` cleans up per bot.
 * Callers must destroy any leftover team sandboxes and clear those
 * providerRefs before invoking this so a failed `sandbox.destroy` cannot lose
 * the only persisted handle. Returns the space the client should switch to
 * when the active space was deleted (the current space when deleting another;
 * otherwise the default, else the oldest remaining). */
export async function deleteEmptySpaceForMember(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<{ id: string }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const claim = await tx.space.findFirst({
          where: { id: input.spaceId, deletionClaimId: input.claimId },
          select: { id: true },
        });
        if (!claim) throw new SpaceDeletionInProgressError();
        const planned = await assertEmptySpaceDeletable(tx, input);
        await tx.space.delete({ where: { id: input.spaceId } });
        if (input.spaceId !== input.currentSpaceId) return { id: input.currentSpaceId };
        const remaining = planned.memberships.filter(
          (membership) => membership.spaceId !== input.spaceId,
        );
        const fallback = remaining.find((membership) => membership.space.isDefault) ?? remaining[0];
        if (!fallback) throw new CannotDeleteLastSpaceError();
        return { id: fallback.spaceId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Rename one of the owner's spaces. */
export async function renameSpaceForMember(
  prisma: PrismaClient,
  input: SpaceTargetInput & { name: string },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const owned = await loadOwnedSpace(tx, input);
        if (owned.deletingAt) throw new SpaceDeletionInProgressError();
        await tx.space.update({ where: { id: input.spaceId }, data: { name } });
        return { id: input.spaceId, name };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
