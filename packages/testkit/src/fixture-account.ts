import { createHmac, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { bootstrapAdmin } from "@rakazo/auth";
import { resolveAuthSecret } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb } from "@rakazo/db";
import { hashPassword } from "better-auth/crypto";

/** Private database fixture setup; never mounted on the application HTTP server. */
export async function fixtureAccountResponse(
  init: RequestInit = {},
  prisma?: PrismaClient,
): Promise<Response> {
  const input = JSON.parse(String(init.body)) as { email: string; password: string; name: string };
  const seed = async (db: PrismaClient) => {
    let user = await db.user.findUnique({ where: { email: input.email } });
    if (!user) {
      const settings = await db.deploymentSettings.findUnique({ where: { id: "default" } });
      const admin = settings?.ownerUserId
        ? await db.user.findUnique({ where: { id: settings.ownerUserId } })
        : null;
      if (admin && admin.email === process.env.RAKAZO_ADMIN_EMAIL) {
        user = await db.user.update({
          where: { id: admin.id },
          data: { name: input.name, email: input.email, emailVerified: true },
        });
        await db.account.updateMany({
          where: { userId: user.id, providerId: "credential" },
          data: { password: await hashPassword(input.password) },
        });
      } else {
        user = await db.user.create({
          data: { id: randomUUID(), name: input.name, email: input.email, emailVerified: true },
        });
        await db.account.create({
          data: {
            id: randomUUID(),
            userId: user.id,
            accountId: user.id,
            providerId: "credential",
            password: await hashPassword(input.password),
          },
        });
        await bootstrapUserSpace(db, user, { claimDeploymentOwner: false });
      }
    }
    const membership = await db.member.findFirstOrThrow({ where: { userId: user.id } });
    const token = randomUUID();
    await db.session.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 86400_000),
        activeOrganizationId: membership.organizationId,
      },
    });
    const signature = createHmac("sha256", resolveAuthSecret()).update(token).digest("base64");
    return Response.json(
      { token, user },
      {
        headers: {
          "set-cookie": `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax`,
        },
      },
    );
  };
  return prisma ? seed(asSystem(prisma)) : withFixtureDb(seed);
}

async function withFixtureDb<T>(
  operation: (db: PrismaClient) => Promise<T>,
  migration = false,
): Promise<T> {
  const url = (migration && process.env.DATABASE_MIGRATION_URL) || process.env.DATABASE_URL;
  if (!url) throw new Error("Database fixtures require DATABASE_URL");
  const { prisma, pool } = createDb(url);
  try {
    return await operation(asSystem(prisma));
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

/** Serial E2E setup clears the previous scenario before bootstrapping the singleton. */
export async function resetAdminFixture(email: string, password: string, name: string) {
  return resetFixtureDatabase(async (db) => {
    const admin = await bootstrapAdmin(db, { email, password });
    await db.user.update({ where: { id: admin.userId }, data: { name } });
    return admin;
  });
}

export async function clearFixtureDatabase() {
  return resetFixtureDatabase(async () => undefined);
}

async function resetFixtureDatabase<T>(afterReset: (db: PrismaClient) => Promise<T>) {
  if (process.env.RAKAZO_E2E_DATABASE_RESET !== "1" && process.env.VERIFY_DATABASE !== "1")
    throw new Error("E2E database reset requires the isolated E2E harness");
  return withFixtureDb(async (db) => {
    const manifest = process.env.RAKAZO_E2E_COMPUTER_MANIFEST;
    if (manifest) {
      const computers = await db.computer.findMany({
        where: { providerRef: { not: null } },
        select: { homeKey: true, kind: true, providerRef: true, userId: true, spaceId: true },
      });
      if (computers.length)
        await appendFile(
          manifest,
          `${computers.map((computer) => JSON.stringify(computer)).join("\n")}\n`,
        );
    }
    const tables = await db.$queryRaw<
      Array<{ tablename: string }>
    >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const reset = tables
      .filter(({ tablename }) => tablename !== "_prisma_migrations")
      .map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`);
    if (reset.length) await db.$executeRawUnsafe(`TRUNCATE TABLE ${reset.join(", ")} CASCADE`);
    return afterReset(db);
  }, true);
}
