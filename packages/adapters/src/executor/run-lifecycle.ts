import type { JobPublisher, NotificationMessage } from "@rakazo/adapter-kit";
import {
  routineRetryJob,
  routineWakeupJob,
  runContinueJob,
  TransientModelError,
} from "@rakazo/adapter-kit";
import { displayName, isBackgroundRunTrigger } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { returnBotMessageOutcome } from "../bot-messages.js";
import { withComputerScreenAvailability } from "../computer-screens.js";
import type { TakeoverResumeCheckpoint } from "../takeover-resume.js";
import { TAKEOVER_RESUME_CHECKPOINTS } from "../takeover-resume.js";
import type { ExecutorDeps } from "./deps.js";
import { ROUTINE_RETRY_DELAY_MS, ROUTINE_RETRY_NEXT_RUN_WINDOW_MS } from "./desktop-guard.js";

export async function deferFutureRoutine(
  jobs: JobPublisher,
  routineId: string,
  scheduledAt: Date,
): Promise<boolean> {
  if (scheduledAt.getTime() <= Date.now() + 1_000) return false;
  await jobs.enqueue(routineWakeupJob(routineId, scheduledAt));
  return true;
}

export async function computerScreenToolResult(
  work: () => Promise<unknown>,
  finish?: (result: unknown) => Promise<unknown>,
) {
  const result = await withComputerScreenAvailability(work);
  return finish ? finish(result) : result;
}

export async function runNotificationsEnabled(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
): Promise<boolean> {
  return (await runNotice(prisma, run)).enabled;
}

async function runNotice(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
  routineId?: string | null,
): Promise<{ enabled: boolean; groupId: string | null }> {
  // A routine carries its own notify setting, which decides on its failures.
  const routine = routineId
    ? await prisma.routine.findUnique({ where: { id: routineId }, select: { notify: true } })
    : null;
  const source = await prisma.run.findFirst({
    where: {
      botId: run.botId,
      threadId: run.threadId,
      spaceId: run.spaceId,
      userId: run.userId,
    },
    select: {
      bot: { select: { notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });
  if (!source) return { enabled: false, groupId: null };
  return {
    enabled: routine ? routine.notify : Boolean(source.thread.groupId || source.bot.notifyOnFinish),
    groupId: source.thread.groupId,
  };
}

export function routineNextRunIsNear(nextRunAt: Date | null, retryAt: number): boolean {
  return Boolean(nextRunAt && nextRunAt.getTime() - retryAt <= ROUTINE_RETRY_NEXT_RUN_WINDOW_MS);
}

/**
 * Queue one later retry of a routine run that a transient model error stopped before it posted
 * a message or called a tool. Effects are keyed to their run, so a retry after either could
 * repeat them. Returns whether a retry was queued.
 */
export async function scheduleRoutineRetry(
  deps: ExecutorDeps,
  run: {
    id: string;
    threadId: string;
    trigger: string;
    routineId: string | null;
    retryOfRunId: string | null;
  },
  error: unknown,
): Promise<boolean> {
  if (
    run.trigger !== "routine" ||
    !run.routineId ||
    run.retryOfRunId ||
    !(error instanceof TransientModelError)
  ) {
    return false;
  }
  try {
    const retryAt = Date.now() + ROUTINE_RETRY_DELAY_MS;
    const [routine, toolCalls, botMessages] = await Promise.all([
      deps.prisma.routine.findUnique({
        where: { id: run.routineId },
        select: { nextRunAt: true },
      }),
      deps.prisma.event.count({ where: { runId: run.id, type: "agent.tool.called" } }),
      deps.prisma.message.count({
        where: { threadId: run.threadId, runId: run.id, role: "bot" },
      }),
    ]);
    if (!routine || toolCalls > 0 || botMessages > 0) return false;
    if (routineNextRunIsNear(routine.nextRunAt, retryAt)) return false;
    await deps.jobs.enqueue(routineRetryJob(run.id, new Date(retryAt)));
    return true;
  } catch (scheduleError) {
    getLogger().error("routine retry schedule", scheduleError);
    return false;
  }
}

export async function notifyFailedRoutineRun(
  deps: ExecutorDeps,
  failed: Parameters<typeof notifyRun>[1] & { error: string | null },
  options: { retryOnFailure?: boolean } = {},
) {
  const bot = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: failed.botId },
    select: { name: true },
  });
  await notifyRun(
    deps,
    failed,
    {
      kind: "failure",
      title: `${displayName(bot.name, "Bot")} failed`,
      body: failed.error ?? "",
      botId: failed.botId,
      threadId: failed.threadId,
    },
    options,
  );
}

/** Fails a run that never reached the model and tells the people waiting on it. */
export async function failRunBeforeTurn(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    taskId: string;
    trigger: string;
    routineId?: string | null;
    sourceMessageId?: string | null;
  },
  botName: string,
  lease: { attemptId: string; workerId: string; fence: number },
  message: string,
): Promise<void> {
  const failed = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    taskId: run.taskId,
    attemptId: lease.attemptId,
    leaseOwner: lease.workerId,
    leaseFence: lease.fence,
    outcome: "failed",
    error: message,
  });
  if (!failed) return;
  if (failed.continuationRunId) {
    await deps.jobs
      .enqueue(runContinueJob(failed.continuationRunId))
      .catch((error) => getLogger().error("steering continuation enqueue", error));
  }
  if (run.trigger === "bot_message") {
    await returnBotMessageOutcome(
      deps,
      run,
      { id: run.botId, name: botName },
      `Could not complete the delegated request: ${message}`,
      "status",
      { forceUnread: true },
    ).catch((error) => getLogger().error("bot message failure return", error));
  }
  if (!failed.continuationRunId) {
    await notifyRun(deps, run, {
      kind: "failure",
      title: `${displayName(botName, "Bot")} failed`,
      body: message,
      botId: run.botId,
      threadId: run.threadId,
    });
  }
}

export async function notifyRun(
  deps: ExecutorDeps,
  run: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    trigger: string;
    routineId?: string | null;
  },
  message: NotificationMessage,
  options: { retryOnFailure?: boolean } = {},
) {
  if (
    !deps.notifications ||
    (isBackgroundRunTrigger(run.trigger) && message.kind !== "help" && message.kind !== "takeover")
  )
    return;
  const routineId = message.kind === "failure" ? run.routineId : null;
  const notice = await runNotice(deps.prisma, run, routineId).catch((error) => {
    if (options.retryOnFailure) throw error;
    getLogger().error("notification preference lookup", error);
    return null;
  });
  if (!notice?.enabled) return;
  await deps.notifications
    .send(notice.groupId ? { ...message, groupId: notice.groupId } : message, {
      operationId: "notify",
      traceId: run.botId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      signal: new AbortController().signal,
    })
    .catch((error) => {
      if (options.retryOnFailure) throw error;
      getLogger().error("run notification", error);
    });
}

export async function renewRunLease(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
): Promise<boolean> {
  const renewed = await deps.prisma.run.updateMany({
    where: {
      id: runId,
      status: "running",
      leaseOwner: workerId,
      leaseFence: fence,
    },
    data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return renewed.count === 1;
}

/** Consecutive setup failures, including this one, after which a run fails instead of retrying. */
export const RUN_SETUP_FAILURE_LIMIT = 8;

/**
 * Setup failures in a row before the current attempt. Busy-computer and database waits are
 * setup_failed attempts without an error; they neither count nor break the streak.
 */
export async function setupFailureStreak(prisma: PrismaClient, runId: string): Promise<number> {
  const recent = await prisma.attempt.findMany({
    where: {
      runId,
      status: { not: "running" },
      NOT: { status: "setup_failed", error: null },
    },
    orderBy: { fence: "desc" },
    take: RUN_SETUP_FAILURE_LIMIT,
    select: { status: true },
  });
  const streak = recent.findIndex((attempt) => attempt.status !== "setup_failed");
  return streak === -1 ? recent.length : streak;
}

export function computerRetryDelay(fence: number): number {
  return Math.min(10_000, 250 * 2 ** Math.min(Math.max(fence - 1, 0), 5));
}

function computerRunRequeueData(
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  error: string | null = null,
  heldForTakeover = false,
) {
  return {
    status:
      heldForTakeover && !resumeCheckpoint ? ("waiting_takeover" as const) : ("queued" as const),
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: resumeCheckpoint,
  };
}

export async function writeComputerRunRequeue(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
  error: string | null = null,
): Promise<boolean> {
  const whereLease = {
    id: runId,
    status: "running" as const,
    leaseOwner: workerId,
    leaseFence: fence,
  };
  const releasedHold = {
    status: "queued" as const,
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  const preserve = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  if (preserve.count === 1) return true;
  const planned = await deps.prisma.run.updateMany({
    where: { ...whereLease, checkpoint: null },
    data: computerRunRequeueData(resumeCheckpoint, error, heldForTakeover),
  });
  if (planned.count === 1) return true;
  const retried = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  return retried.count === 1;
}

export async function requeueComputerRun(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
): Promise<void> {
  const released = await writeComputerRunRequeue(
    deps,
    runId,
    workerId,
    fence,
    resumeCheckpoint,
    heldForTakeover,
  );
  if (!released) return;
  await deps.jobs.enqueue({
    ...runContinueJob(runId),
    availableAt: new Date(Date.now() + computerRetryDelay(fence)),
  });
}
