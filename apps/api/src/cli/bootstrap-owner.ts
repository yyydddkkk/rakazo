import { bootstrapAdmin } from "@rakazo/auth";
import { createDb, runAsSystem } from "@rakazo/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { prisma, pool } = createDb(databaseUrl);
try {
  const result = await runAsSystem("administrator bootstrap", () =>
    bootstrapAdmin(prisma, {
      email: process.env.RAKAZO_ADMIN_EMAIL,
      password: process.env.RAKAZO_ADMIN_PASSWORD,
    }),
  );
  process.stdout.write(
    result.created ? "Administrator account created\n" : "Administrator account ready\n",
  );
} finally {
  await prisma.$disconnect();
  await pool.end();
}
