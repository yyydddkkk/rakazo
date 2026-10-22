import { randomBytes } from "node:crypto";
import type { PrismaClient } from "./client.js";

function newId(): string {
  return randomBytes(16).toString("hex");
}

/** Prisma unique-constraint violation; anything else must still throw. */
function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/** Provision the personal organization, Space, memberships, memory and preferences. */
export async function bootstrapUserSpace(
  prisma: Pick<
    PrismaClient,
    | "organization"
    | "member"
    | "space"
    | "spaceMember"
    | "deploymentSettings"
    | "memoryDocument"
    | "notificationPreference"
  >,
  user: { id: string },
  options: { claimDeploymentOwner?: boolean } = {},
): Promise<{ spaceId: string }> {
  const claimDeploymentOwner = options.claimDeploymentOwner ?? true;
  // Reuse existing personal boundaries when provisioning is retried.
  const slug = `user-${user.id.slice(0, 12)}`;
  let orgId = newId();
  try {
    await prisma.organization.create({
      data: { id: orgId, name: "Personal", slug, createdAt: new Date() },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    orgId = (await prisma.organization.findUniqueOrThrow({ where: { slug } })).id;
  }
  await prisma.member
    .create({
      data: {
        id: newId(),
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.space
    .create({
      data: {
        id: orgId,
        organizationId: orgId,
        name: "Personal",
        isDefault: true,
        createdByUserId: user.id,
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.spaceMember
    .create({
      data: {
        id: newId(),
        spaceId: orgId,
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ownerUserId: claimDeploymentOwner ? user.id : null,
      signupsEnabled: false,
      signupAllowlist: "",
      signupPolicyInitialized: true,
    },
    update: {},
  });
  if (claimDeploymentOwner) {
    // Conditional claim: only the first concurrent claimant wins the seat.
    await prisma.deploymentSettings.updateMany({
      where: { id: "default", ownerUserId: null },
      data: { ownerUserId: user.id },
    });
  }
  const hasMemory = await prisma.memoryDocument.findFirst({
    where: { spaceId: orgId, userId: user.id, scope: "user", path: "MEMORY.md" },
  });
  if (!hasMemory) {
    await prisma.memoryDocument
      .create({
        data: {
          spaceId: orgId,
          userId: user.id,
          scope: "user",
          path: "MEMORY.md",
          content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        },
      })
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
      });
  }
  await prisma.notificationPreference
    .create({
      data: {
        spaceId: orgId,
        userId: user.id,
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  return { spaceId: orgId };
}
