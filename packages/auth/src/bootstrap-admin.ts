import { randomBytes } from "node:crypto";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace } from "@rakazo/db";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

export interface BootstrapAdminCredentials {
  email?: string;
  password?: string;
}

const ADMIN_BOOTSTRAP_LOCK = 872014;

/** Private, atomic bootstrap. Existing credentials are never changed by environment values. */
export async function bootstrapAdmin(
  prisma: PrismaClient,
  credentials: BootstrapAdminCredentials = {},
): Promise<{ userId: string; spaceId: string; created: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_BOOTSTRAP_LOCK})`;
      const [users, spaces, organizations, settings] = await Promise.all([
        tx.user.findMany({ select: { id: true }, take: 2 }),
        tx.space.findMany({ select: { id: true, organizationId: true }, take: 2 }),
        tx.organization.findMany({ select: { id: true }, take: 2 }),
        tx.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { ownerUserId: true },
        }),
      ]);
      if (users.length > 1 || spaces.length > 1 || organizations.length > 1) {
        throw new Error(
          "Single-user setup requires exactly one user, organization and space; reconcile existing data before starting",
        );
      }
      const user = users[0];
      if (user) {
        const [credentials, membership] = await Promise.all([
          tx.account.findMany({
            where: { userId: user.id, providerId: "credential" },
            select: { accountId: true, password: true },
            take: 2,
          }),
          tx.spaceMember.findFirst({
            where: { userId: user.id },
            select: { spaceId: true, organizationId: true, role: true },
          }),
        ]);
        const credential = credentials[0];
        if (!credential?.password)
          throw new Error(
            "Existing administrator has no password; configure a password before starting",
          );
        if (credentials.length !== 1 || credential.accountId !== user.id) {
          throw new Error(
            "Existing administrator credential setup is incomplete; reconcile credentials before starting",
          );
        }
        const space = spaces[0];
        if (
          !space ||
          organizations[0]?.id !== space.organizationId ||
          membership?.spaceId !== space.id ||
          membership.organizationId !== space.organizationId ||
          membership.role !== "owner" ||
          settings?.ownerUserId !== user.id
        ) {
          throw new Error(
            "Existing administrator setup is incomplete; reconcile ownership and space before starting",
          );
        }
        return { userId: user.id, spaceId: space.id, created: false };
      }
      if (spaces.length || organizations.length)
        throw new Error(
          "Existing space has no administrator; reconcile existing data before starting",
        );
      if (settings?.ownerUserId) {
        throw new Error(
          "Existing deployment owner has no administrator; reconcile ownership before starting",
        );
      }
      const email = credentials.email?.trim().toLowerCase();
      const password = credentials.password;
      if (!email || !password)
        throw new Error(
          "RAKAZO_ADMIN_EMAIL and RAKAZO_ADMIN_PASSWORD are required for an empty database",
        );
      if (!z.email().safeParse(email).success || email.endsWith("@messaging.invalid"))
        throw new Error("RAKAZO_ADMIN_EMAIL must be a valid email address");
      if (password === "replace-with-a-strong-password")
        throw new Error("Replace the RAKAZO_ADMIN_PASSWORD placeholder before starting");
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH)
        throw new Error(
          `RAKAZO_ADMIN_PASSWORD must contain ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`,
        );
      const id = randomBytes(16).toString("hex");
      await tx.user.create({ data: { id, email, name: "Admin", emailVerified: true } });
      await tx.account.create({
        data: {
          id: randomBytes(16).toString("hex"),
          userId: id,
          accountId: id,
          providerId: "credential",
          password: await hashPassword(password),
        },
      });
      const { spaceId } = await bootstrapUserSpace(tx, { id });
      return { userId: id, spaceId, created: true };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
}
