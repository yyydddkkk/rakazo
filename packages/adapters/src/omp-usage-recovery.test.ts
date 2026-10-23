import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { OmpUsageScope } from "./omp-usage.js";
import { createOmpUsageRecovery } from "./omp-usage-recovery.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
const scope: OmpUsageScope = {
  spaceId: "space-fixture",
  userId: "user-fixture",
  botId: "bot-fixture",
  threadId: "thread-fixture",
  runId: "run-fixture",
};
const event: UsageEvent = {
  type: "usage",
  provider: "fixture",
  model: "fixture-model",
  callId: "run-fixture:main:message-1",
  inputTokens: 10,
  outputTokens: 2,
};
const original = {
  id: scope.runId,
  spaceId: scope.spaceId,
  userId: scope.userId,
  botId: scope.botId,
  threadId: scope.threadId,
};
function fakePrisma() {
  const findUnique = vi.fn(async () => {
    expect(currentDbContext()).toEqual({
      kind: "system",
      reason: "recover original omp usage attribution",
    });
    return original as typeof original | null;
  });
  const ledger = new Map<string, Record<string, unknown>>();
  const createMany = vi.fn(
    async (args: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => {
      expect(currentDbContext()).toEqual({
        kind: "tenant",
        spaceId: scope.spaceId,
        userId: scope.userId,
      });
      let count = 0;
      for (const row of args.data) {
        const key = String(row.callId);
        if (ledger.has(key)) {
          if (args.skipDuplicates) continue;
          throw { code: "P2002" };
        }
        ledger.set(key, row);
        count++;
      }
      return { count };
    },
  );
  const prisma = { run: { findUnique }, usageRecord: { createMany } } as unknown as Pick<
    PrismaClient,
    "run" | "usageRecord"
  >;
  return { prisma, findUnique, createMany, ledger };
}

describe("omp usage recovery attribution", () => {
  it("uses the original run's protected scope and deduplicates repeated recovery", async () => {
    const { prisma, findUnique, createMany, ledger } = fakePrisma();
    const recover = createOmpUsageRecovery(prisma);
    await recover(event, scope);
    await recover(event, scope);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: scope.runId },
      select: { id: true, spaceId: true, userId: true, botId: true, threadId: true },
    });
    expect(createMany).toHaveBeenCalledTimes(2);
    expect([...ledger.values()]).toEqual([
      expect.objectContaining({
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        runId: scope.runId,
        parentRunId: scope.runId,
        operationId: scope.runId,
        callId: event.callId,
        inputTokens: 10,
        outputTokens: 2,
      }),
    ]);
    expect(currentDbContext()).toBeUndefined();
  });

  it.each(["id", "spaceId", "userId", "botId", "threadId"] as const)(
    "rejects a mismatched original run %s without writing usage",
    async (field) => {
      const { prisma, findUnique, createMany } = fakePrisma();
      findUnique.mockResolvedValue({ ...original, [field]: "different-fixture" });
      await expect(createOmpUsageRecovery(prisma)(event, scope)).rejects.toThrow(
        "does not match the original run",
      );
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it("preserves original financial attribution if the run and bot have already been deleted", async () => {
    const { prisma, findUnique, createMany } = fakePrisma();
    findUnique.mockResolvedValue(null);
    createMany.mockRejectedValueOnce({ code: "P2003" });
    await createOmpUsageRecovery(prisma)(event, scope);
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[1]?.[0]).toEqual({
      data: [
        expect.objectContaining({
          runId: null,
          parentRunId: scope.runId,
          operationId: scope.runId,
          botId: scope.botId,
          spaceId: scope.spaceId,
          userId: scope.userId,
        }),
      ],
      skipDuplicates: true,
    });
  });
});
