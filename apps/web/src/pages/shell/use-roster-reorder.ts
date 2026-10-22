import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { reorderBotTo } from "@rakazo/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { RosterDropTarget } from "./roster-drop";
import { resolveRosterDrop } from "./roster-drop";

export function useRosterReorder({
  rpc,
  bots,
  botsRef,
  setBots,
  botOrderEpochRef,
  pendingBotOrderRef,
  savingBotOrderRef,
  refreshBots,
  refreshGroupThread,
  activeGroupId,
  setSendError,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  bots: Bot[];
  botsRef: MutableRefObject<Bot[]>;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  botOrderEpochRef: MutableRefObject<number>;
  pendingBotOrderRef: MutableRefObject<string[] | null>;
  savingBotOrderRef: MutableRefObject<boolean>;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  refreshGroupThread: (id: string) => Promise<unknown>;
  activeGroupId: MutableRefObject<string | undefined>;
  setSendError: (error: string | null) => void;
}) {
  const { t } = useLingui();
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);
  const [rosterDropKey, setRosterDropKey] = useState<string | null>(null);
  const flushBotOrder = useCallback(async () => {
    if (savingBotOrderRef.current) return;
    savingBotOrderRef.current = true;
    try {
      while (pendingBotOrderRef.current) {
        const botIds = pendingBotOrderRef.current;
        pendingBotOrderRef.current = null;
        try {
          await rpc.bots.reorder({ botIds });
        } catch {
          // Keep a newer order queued during this failed save; only roll back
          // when nothing else is pending.
          if (pendingBotOrderRef.current === null) {
            await refreshBots(false, true).catch(() => undefined);
          }
        }
      }
    } finally {
      savingBotOrderRef.current = false;
      // A reorder may have arrived while saving=true and returned early.
      if (pendingBotOrderRef.current) {
        void flushBotOrder();
      }
    }
  }, [refreshBots]);
  const reorderRosterBot = useCallback(
    (sourceId: string, targetId: string, groupBotIds: string[]) => {
      if (!groupBotIds.includes(sourceId) || !groupBotIds.includes(targetId)) return;
      const current = botsRef.current;
      const reordered = reorderBotTo(current, sourceId, targetId);
      if (reordered === current) return;
      const next = [...reordered];
      botOrderEpochRef.current += 1;
      botsRef.current = next;
      setBots(next);
      pendingBotOrderRef.current = next.map((bot) => bot.id);
      void flushBotOrder();
    },
    [flushBotOrder],
  );
  // Drags only act on bots of the active space; other spaces are read-only here.
  const draggedBot = draggedBotId ? bots.find((bot) => bot.id === draggedBotId) : undefined;
  const rosterDropAction = useCallback(
    (target: RosterDropTarget, sameParent: boolean) =>
      draggedBot ? resolveRosterDrop({ dragged: draggedBot, target, sameParent }) : null,
    [draggedBot],
  );
  const applyRosterDrop = useCallback(
    (target: RosterDropTarget, sameParent: boolean, groupBotIds: string[]) => {
      const action = rosterDropAction(target, sameParent);
      setDraggedBotId(null);
      setRosterDropKey(null);
      if (!action || !draggedBot) return;
      setSendError(null);
      if (action.action === "reorder") {
        reorderRosterBot(draggedBot.id, action.targetBotId, groupBotIds);
        return;
      }
      const request =
        action.action === "move"
          ? rpc.bots.update({ botId: draggedBot.id, sectionId: action.sectionId })
          : rpc.groups.update({
              groupId: action.groupId,
              botIds: action.botIds,
              expectedBotIds: action.botIds.filter((id) => id !== draggedBot.id),
            });
      void request
        .then(async () => {
          await refreshBots();
          if (action.action === "join" && activeGroupId.current === action.groupId) {
            await refreshGroupThread(action.groupId);
          }
        })
        .catch((error) => {
          setSendError(errorText(error, t`Could not save`));
          void refreshBots().catch(() => undefined);
        });
    },
    [draggedBot, refreshBots, reorderRosterBot, rosterDropAction, t],
  );
  return {
    draggedBotId,
    setDraggedBotId,
    rosterDropKey,
    setRosterDropKey,
    reorderRosterBot,
    rosterDropAction,
    applyRosterDrop,
  };
}
