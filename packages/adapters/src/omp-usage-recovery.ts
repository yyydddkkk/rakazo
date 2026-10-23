import type { PrismaClient } from "@rakazo/db";
import { recordUsage, runAsSystem, runAsTenant } from "@rakazo/db";
import type { OmpUsageRecovery } from "./omp-usage.js";

/** Replay the trusted local outbox with its original tenant and operation attribution. */
export function createOmpUsageRecovery(
  prisma: Pick<PrismaClient, "run" | "usageRecord">,
): OmpUsageRecovery {
  return async (event, scope) => {
    const original = await runAsSystem("recover original omp usage attribution", () =>
      prisma.run.findUnique({
        where: { id: scope.runId },
        select: { id: true, spaceId: true, userId: true, botId: true, threadId: true },
      }),
    );
    if (
      original &&
      (original.id !== scope.runId ||
        original.spaceId !== scope.spaceId ||
        original.userId !== scope.userId ||
        original.botId !== scope.botId ||
        original.threadId !== scope.threadId)
    )
      throw new Error("omp usage recovery attribution does not match the original run");
    // Runs/bots can be deleted after a paid call. The private outbox retains the
    // original scope; recordUsage drops only the optional run FK if it disappeared.
    await runAsTenant(scope, () =>
      recordUsage(prisma, event, {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        runId: scope.runId,
        parentRunId: scope.runId,
        operationId: scope.runId,
      }),
    );
  };
}
