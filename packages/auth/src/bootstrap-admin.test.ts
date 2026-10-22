import { bootstrapUserSpace } from "@rakazo/db";
import { verifyPassword } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapAdmin } from "./bootstrap-admin.js";

vi.mock("@rakazo/db", () => ({ bootstrapUserSpace: vi.fn() }));
const credentials = { email: " admin@example.test ", password: "offline-bootstrap-password" };

function fixture({ existing = false } = {}) {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    user: {
      findMany: vi.fn(async () => (existing ? [{ id: "admin" }] : [])),
      create: vi.fn(async (_args: unknown) => ({})),
    },
    account: {
      findMany: vi.fn(async () => [{ accountId: "admin", password: "existing-hash" }]),
      create: vi.fn(async (_args: unknown) => ({})),
    },
    space: {
      findMany: vi.fn(async () =>
        existing ? [{ id: "space", organizationId: "organization", isDefault: true }] : [],
      ),
    },
    organization: { findMany: vi.fn(async () => (existing ? [{ id: "organization" }] : [])) },
    spaceMember: {
      findMany: vi.fn(async () => [
        { spaceId: "space", organizationId: "organization", role: "owner" },
      ]),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        ownerUserId: existing ? "admin" : (null as string | null),
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { tx, prisma: prisma as never };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bootstrapUserSpace).mockResolvedValue({ spaceId: "space" });
});

describe("private administrator bootstrap", () => {
  it("locks before reading and creates the credential and boundaries in one transaction", async () => {
    const f = fixture();
    const result = await bootstrapAdmin(f.prisma, credentials);
    expect(result).toMatchObject({ spaceId: "space", created: true });
    expect(f.tx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("pg_advisory_xact_lock")]),
      872014,
    );
    expect(f.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.user.findMany.mock.invocationCallOrder[0]!,
    );
    expect(f.tx.user.create).toHaveBeenCalledWith({
      data: { id: result.userId, email: "admin@example.test", name: "Admin", emailVerified: true },
    });
    const account = f.tx.account.create.mock.calls[0]![0] as unknown as {
      data: { accountId: string; userId: string; providerId: string; password: string };
    };
    expect(account.data).toMatchObject({
      accountId: result.userId,
      userId: result.userId,
      providerId: "credential",
    });
    expect(account.data.password).not.toBe(credentials.password);
    expect(
      await verifyPassword({ hash: account.data.password, password: credentials.password }),
    ).toBe(true);
    expect(bootstrapUserSpace).toHaveBeenCalledWith(f.tx, { id: result.userId });
  });
  it("requires both credentials only for an empty database", async () => {
    for (const input of [{}, { email: credentials.email }, { password: credentials.password }]) {
      const f = fixture();
      await expect(bootstrapAdmin(f.prisma, input)).rejects.toThrow(
        "required for an empty database",
      );
      expect(f.tx.user.create).not.toHaveBeenCalled();
    }
    const f = fixture({ existing: true });
    await expect(bootstrapAdmin(f.prisma)).resolves.toEqual({
      userId: "admin",
      spaceId: "space",
      created: false,
    });
  });
  it("never resets an existing password or changes ownership from environment", async () => {
    const f = fixture({ existing: true });
    await bootstrapAdmin(f.prisma, {
      email: "different@example.test",
      password: "different-password",
    });
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.account.create).not.toHaveBeenCalled();
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });
  it.each(["user", "organization"] as const)(
    "refuses multiple %s records without mutation",
    async (model) => {
      const f = fixture({ existing: true });
      f.tx[model].findMany.mockResolvedValue([{ id: "one" }, { id: "two" }] as never);
      await expect(bootstrapAdmin(f.prisma, credentials)).rejects.toThrow(
        "Single-user setup requires",
      );
      expect(f.tx.user.create).not.toHaveBeenCalled();
      expect(bootstrapUserSpace).not.toHaveBeenCalled();
    },
  );
  it("accepts several spaces in the one organization when the user owns each", async () => {
    const f = fixture({ existing: true });
    f.tx.space.findMany.mockResolvedValue([
      { id: "older", organizationId: "organization", isDefault: false },
      { id: "space", organizationId: "organization", isDefault: true },
    ]);
    f.tx.spaceMember.findMany.mockResolvedValue([
      { spaceId: "older", organizationId: "organization", role: "owner" },
      { spaceId: "space", organizationId: "organization", role: "owner" },
    ]);
    await expect(bootstrapAdmin(f.prisma)).resolves.toEqual({
      userId: "admin",
      spaceId: "space",
      created: false,
    });
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "a space the user does not own",
      memberships: [{ spaceId: "space", organizationId: "organization", role: "owner" }],
      spaces: [
        { id: "space", organizationId: "organization", isDefault: true },
        { id: "other", organizationId: "organization", isDefault: false },
      ],
    },
    {
      name: "a non-owner membership",
      memberships: [
        { spaceId: "space", organizationId: "organization", role: "owner" },
        { spaceId: "other", organizationId: "organization", role: "member" },
      ],
      spaces: [
        { id: "space", organizationId: "organization", isDefault: true },
        { id: "other", organizationId: "organization", isDefault: false },
      ],
    },
    {
      name: "a space outside the organization",
      memberships: [
        { spaceId: "space", organizationId: "organization", role: "owner" },
        { spaceId: "other", organizationId: "elsewhere", role: "owner" },
      ],
      spaces: [
        { id: "space", organizationId: "organization", isDefault: true },
        { id: "other", organizationId: "elsewhere", isDefault: false },
      ],
    },
  ])("refuses $name", async ({ memberships, spaces }) => {
    const f = fixture({ existing: true });
    f.tx.space.findMany.mockResolvedValue(spaces);
    f.tx.spaceMember.findMany.mockResolvedValue(memberships);
    await expect(bootstrapAdmin(f.prisma)).rejects.toThrow("setup is incomplete");
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });
  it("refuses an existing user without a credential instead of creating one", async () => {
    const f = fixture({ existing: true });
    f.tx.account.findMany.mockResolvedValue([]);
    await expect(bootstrapAdmin(f.prisma, credentials)).rejects.toThrow("has no password");
    expect(f.tx.account.create).not.toHaveBeenCalled();
  });
  it.each([
    { accounts: [{ accountId: "different-user", password: "existing-hash" }] },
    {
      accounts: [
        { accountId: "admin", password: "existing-hash" },
        { accountId: "admin", password: "duplicate-hash" },
      ],
    },
  ])("refuses invalid credential bindings without mutation", async ({ accounts }) => {
    const f = fixture({ existing: true });
    f.tx.account.findMany.mockResolvedValue(accounts);
    await expect(bootstrapAdmin(f.prisma, credentials)).rejects.toThrow(
      "credential setup is incomplete",
    );
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.account.create).not.toHaveBeenCalled();
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });
  it("refuses an orphaned deployment owner before creating administrator resources", async () => {
    const f = fixture();
    f.tx.deploymentSettings.findUnique.mockResolvedValue({ ownerUserId: "orphaned-owner" });
    await expect(bootstrapAdmin(f.prisma, credentials)).rejects.toThrow(
      "deployment owner has no administrator",
    );
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.account.create).not.toHaveBeenCalled();
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });
  it("refuses ambiguous ownership and orphaned resources", async () => {
    const f = fixture({ existing: true });
    f.tx.deploymentSettings.findUnique.mockResolvedValue({ ownerUserId: "someone-else" });
    await expect(bootstrapAdmin(f.prisma, credentials)).rejects.toThrow("setup is incomplete");
    const empty = fixture();
    empty.tx.space.findMany.mockResolvedValue([
      { id: "orphan", organizationId: "organization", isDefault: true },
    ]);
    await expect(bootstrapAdmin(empty.prisma, credentials)).rejects.toThrow("no administrator");
    expect(empty.tx.user.create).not.toHaveBeenCalled();
  });
  it.each([
    { email: "invalid", password: credentials.password },
    { email: "admin@example..test", password: credentials.password },
    { email: "admin@-example.test", password: credentials.password },
    { email: "phone@messaging.invalid", password: credentials.password },
    { email: credentials.email, password: "short" },
    { email: credentials.email, password: "replace-with-a-strong-password" },
  ])("rejects invalid bootstrap credentials", async (input) => {
    const f = fixture();
    await expect(bootstrapAdmin(f.prisma, input)).rejects.toThrow(/RAKAZO_ADMIN_/);
    expect(f.tx.user.create).not.toHaveBeenCalled();
  });
  it("propagates boundary creation failure so the transaction rolls back", async () => {
    const f = fixture();
    vi.mocked(bootstrapUserSpace).mockRejectedValue(new Error("boundary write failed"));
    await expect(bootstrapAdmin(f.prisma, credentials)).rejects.toThrow("boundary write failed");
  });
});
