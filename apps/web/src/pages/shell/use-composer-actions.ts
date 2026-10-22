import { useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ComputerStatus,
  MessageReaction,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT, attachmentMaxBytes, attachmentSizeLabel } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import {
  attachmentsForThread,
  inferAttachmentMimeType,
  resolveComposerSendPlan,
} from "@rakazo/core";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { requestBrowserNotificationPermission } from "../../lib/browser-notifications";
import { newClientId } from "../../lib/client-id";
import { readFileAsBase64, revokePendingAttachmentPreviews } from "../../lib/pending-attachments";
import type { createSpaceRpc } from "../../lib/rpc";
import { applyThreadSendReceipt, clearActiveThreadRuns } from "../../lib/thread-events";
import { errorText } from "../../lib/user-error";
import type { PendingAttachment } from "./chat-shared";

type Rpc = ReturnType<typeof createSpaceRpc>;

/** Everything the composer and transcript do to the active thread: answer, react, attach, send, stop. */
export function useComposerActions({
  rpc,
  activeBotId,
  activeGroupId,
  refreshThreadRef,
  refreshGroupThreadRef,
  setSendError,
  pendingAttachments,
  setPendingAttachments,
  setAttachmentNotice,
  fileInputRef,
  bootstrapMe,
  sending,
  setSending,
  sendingRef,
  botsRef,
  flushPendingBrowserNotifications,
  cancelFocusPrompt,
  focusPromptBotIdRef,
  clearReply,
  activeReplyTarget,
  activeReplyQuote,
  navigate,
  refreshBots,
  updateSnapshot,
  terminalRunReceipts,
  computerRef,
  commitComputer,
}: {
  rpc: Rpc;
  activeBotId: MutableRefObject<string | undefined>;
  activeGroupId: MutableRefObject<string | undefined>;
  refreshThreadRef: MutableRefObject<(id: string) => Promise<unknown>>;
  refreshGroupThreadRef: MutableRefObject<(id: string) => Promise<unknown>>;
  setSendError: (error: string | null) => void;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  setAttachmentNotice: (notice: string | null) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  bootstrapMe: Parameters<typeof attachmentMaxBytes>[0];
  sending: boolean;
  setSending: (sending: boolean) => void;
  sendingRef: MutableRefObject<boolean>;
  botsRef: MutableRefObject<Bot[]>;
  flushPendingBrowserNotifications: () => void;
  cancelFocusPrompt: () => void;
  focusPromptBotIdRef: MutableRefObject<string | null>;
  clearReply: () => void;
  activeReplyTarget: ThreadMessage | null;
  activeReplyQuote: string | null;
  navigate: (path: string) => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  updateSnapshot: (update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) => void;
  terminalRunReceipts: MutableRefObject<Set<string>>;
  computerRef: MutableRefObject<ComputerStatus | null>;
  commitComputer: (next: ComputerStatus | null) => void;
}) {
  const { t } = useLingui();
  const answerMessage = useCallback(
    async (message: ThreadMessage, text: string, username?: string, dismiss?: boolean) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      await rpc.threads.answer({
        ...(groupId ? { groupId } : { botId: botId! }),
        runId: message.runId ?? "",
        messageId: message.id,
        answer: text,
        ...(username ? { username } : {}),
        ...(dismiss ? { dismiss: true as const } : {}),
      });
      // The answer is saved; live events can reconcile a failed refresh.
      try {
        if (groupId && activeGroupId.current === groupId) {
          await refreshGroupThreadRef.current(groupId);
        } else if (botId && activeBotId.current === botId) {
          await refreshThreadRef.current(botId);
        }
      } catch {}
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        const result = await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientId(),
        });
        if (result.runIds?.length) {
          // The reaction is saved; a failed refresh is caught up by live events.
          try {
            if (groupId && activeGroupId.current === groupId) {
              await refreshGroupThreadRef.current(groupId);
            } else if (botId && activeBotId.current === botId) {
              await refreshThreadRef.current(botId);
            }
          } catch {}
        }
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(errorText(error, t`Could not update reaction`));
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return false;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > attachmentMaxBytes(bootstrapMe)) {
          skipped.push(
            t`${file.name} (over ${attachmentSizeLabel(attachmentMaxBytes(bootstrapMe))})`,
          );
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return next.length > 0;
    },
    [pendingAttachments, bootstrapMe, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  const sendMessage = useCallback(
    async (text: string, mentions: ComposerMention[], clientNonce: string) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return false;
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return false;
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup ? undefined : initialBotTarget;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      const trimmed = plan.trimmed;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      const dropDelayedSetup = () => {
        // Only after successful engagement so a failed upload/send keeps the setup card.
        if (initialBotTarget && focusPromptBotIdRef.current === initialBotTarget) {
          cancelFocusPrompt();
        }
      };
      // Keep the draft cleared once any part of the submission is confirmed accepted.
      let accepted = false;
      try {
        if (plan.shouldRunRoutines) {
          // Settle every run first so one that was accepted is never repeated.
          const runs = await Promise.allSettled(
            plan.routineIds.map((routineId) =>
              rpc.routines.testRun({
                routineId,
                clientNonce: `routine-mention:${clientNonce}:${routineId}`,
              }),
            ),
          );
          accepted = runs.some((run) => run.status === "fulfilled");
          for (const run of runs) if (run.status === "rejected") throw run.reason;
        }
        if (!plan.shouldSend) {
          dropDelayedSetup();
          clearReply();
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
          setAttachmentNotice(null);
          if (reroutedToGroup && groupTarget) {
            navigate(`/app/g/${groupTarget}`);
            return true;
          }
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return true;
        }
        const artifactIds: string[] = [];
        for (const pending of attachments) {
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(t`Unsupported file type: ${pending.file.name}`);
          }
          const contentBase64 = await readFileAsBase64(pending.file);
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? { groupId: groupTarget, name: pending.file.name, mimeType, contentBase64 }
              : { botId: botTarget!, name: pending.file.name, mimeType, contentBase64 },
          );
          artifactIds.push(artifact.id);
        }
        if (groupTarget) {
          await rpc.threads.send({
            groupId: groupTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: reroutedToGroup ? undefined : activeReplyTarget?.id,
            replyQuote: reroutedToGroup ? undefined : (activeReplyQuote ?? undefined),
          });
          accepted = true;
        } else if (botTarget) {
          const sent = await rpc.threads.send({
            botId: botTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: activeReplyTarget?.id,
            replyQuote: activeReplyQuote ?? undefined,
          });
          accepted = true;
          if (activeBotId.current === botTarget) {
            updateSnapshot((current) =>
              applyThreadSendReceipt(
                current,
                {
                  botId: botTarget,
                  runId: sent.runId,
                  taskId: sent.taskId,
                },
                terminalRunReceipts.current,
              ),
            );
          }
        }
        dropDelayedSetup();
        clearReply();
        revokePendingAttachmentPreviews(attachments);
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        // Refresh sidebar status even when a bot→group reroute navigates away below.
        void refreshBots().catch(() => undefined);
        if (reroutedToGroup && groupTarget) {
          navigate(`/app/g/${groupTarget}`);
          return true;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) void refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        else if (botTarget) void refreshThreadRef.current(botTarget).catch(() => undefined);
        return true;
      } catch (error) {
        if (reroutedToGroup && groupTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        }
        return accepted;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [
      activeReplyTarget?.id,
      activeReplyQuote,
      clearReply,
      flushPendingBrowserNotifications,
      navigate,
      pendingAttachments,
      sending,
      t,
    ],
  );
  const stopRun = useCallback(async () => {
    if (sending) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(errorText(error, t`Failed to stop`));
          }
          return;
        }
        // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to stop`));
        }
        return;
      }
      // Clear local run/busy immediately rather than waiting for run.cancelled so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [sending, t]);
  return {
    answerMessage,
    reactToMessage,
    onAttachmentPick,
    removeAttachment,
    sendMessage,
    stopRun,
  };
}
