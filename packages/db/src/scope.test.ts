import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership } from "./scope.js";

function prismaForMembership(count = 1) {
  return {
    spaceMember: {
      findMany: vi.fn(async () =>
        Array.from({ length: count }, (_, index) => ({
          userId: "user-1",
          spaceId: `space-${index}`,
          member: { user: { email: "owner@example.test" } },
        })),
      ),
    },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "user-1" })) },
  } as unknown as PrismaClient;
}

describe("requireMembership", () => {
  it("uses the sole Space membership with or without the matching header", async () => {
    const prisma = prismaForMembership();
    const expected = {
      userId: "user-1",
      spaceId: "space-0",
      email: "owner@example.test",
      isDeploymentOwner: true,
    };
    await expect(requireMembership(prisma, "user-1")).resolves.toEqual(expected);
    await expect(requireMembership(prisma, "user-1", "space-0")).resolves.toEqual(expected);
    expect(prisma.spaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" }, take: 2 }),
    );
  });
  it("rejects a conflicting requested space even when a personal membership exists", async () => {
    await expect(
      requireMembership(prismaForMembership(), "user-1", "space-foreign"),
    ).rejects.toBeInstanceOf(IsolationError);
  });
  it.each([0, 2])("rejects %s memberships instead of choosing one", async (count) => {
    await expect(requireMembership(prismaForMembership(count), "user-1")).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});
