import type { MessageBlock } from "@rakazo/contracts";
import { isBackgroundRunTrigger, redactSecrets } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type Prisma,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./deps.js";

export function redactBlocks(blocks: MessageBlock[], secrets: string[]): MessageBlock[] {
  return blocks.map((block) => {
    if (block.kind === "text") {
      return {
        kind: "text" as const,
        text: redactSecrets(block.text, secrets),
      };
    }
    if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
      return { ...block, text: redactSecrets(block.text, secrets) };
    }
    return block;
  });
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export async function publishMessage(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string; trigger: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread: boolean | undefined = run.trigger === "bot_message" ? false : undefined,
  clientNonce?: string,
) {
  if (isBackgroundRunTrigger(run.trigger)) {
    blocks = blocks.filter((block) => block.kind === "ask" || block.kind === "computer");
    if (blocks.length === 0) return null;
  }
  const committed = await deps.prisma.$transaction((tx) =>
    persistMessageInTransaction(tx, run, role, blocks, markUnread, clientNonce),
  );
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("thread message realtime notification", error);
  });
  return committed.message;
}

export async function persistMessageInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread?: boolean,
  clientNonce?: string,
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role,
    blocks,
    botId: run.botId,
    runId: run.id,
    markUnread,
    clientNonce,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    runId: run.id,
    payload: {
      messageId: message.id,
      role,
      blocks,
    },
  });
  return { message, eventSeq: event.seq };
}
