import type { Bot, BotSection, Group } from "@rakazo/contracts";
import type { Dispatch, SetStateAction } from "react";
import { lazyOverlay } from "../../components/ErrorBoundary";
import type { Panel } from "../../lib/right-panel-state";
import { rightPanelStorageKey } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import type { ChatTarget, SectionTarget } from "./dialog-targets";

const BotContextMenu = lazyOverlay(() =>
  import("../BotContextMenu").then((module) => module.BotContextMenu),
);

/** The context menu of one roster entry: exactly one of `contextBot` and `contextGroup` is set. */
export function BotContextMenuContent({
  rpc,
  contextBot,
  contextGroup,
  botSections,
  userId,
  spaceId,
  onClose,
  refreshBots,
  markBotRead,
  markBotUnread,
  setGroups,
  setNewSectionTarget,
  setRenameSectionTarget,
  setDeleteTarget,
  setDeleteGroupTarget,
  setClearTarget,
  beginExplicitPanel,
  showPanel,
  navigate,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  contextBot: Bot | undefined;
  contextGroup: Group | undefined;
  botSections: BotSection[];
  userId: string | undefined;
  spaceId: string | undefined;
  onClose: () => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  markBotRead: (id: string) => Promise<void>;
  markBotUnread: (id: string) => Promise<void>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  setNewSectionTarget: (target: ChatTarget) => void;
  setRenameSectionTarget: (target: SectionTarget) => void;
  setDeleteTarget: (bot: Bot) => void;
  setDeleteGroupTarget: (group: Group) => void;
  setClearTarget: (target: ChatTarget) => void;
  beginExplicitPanel: (destKey: string | null) => void;
  showPanel: (panel: Panel, destKey: string | null) => void;
  navigate: (path: string) => void;
}) {
  const contextChat = contextBot ?? contextGroup;
  if (!contextChat) return null;
  return (
    <BotContextMenu
      bot={contextChat}
      onClose={onClose}
      sections={botSections}
      onTogglePinned={() => {
        onClose();
        const request = contextBot
          ? rpc.bots.update({ botId: contextBot.id, pinned: !contextBot.pinned })
          : rpc.groups.update({
              groupId: contextGroup!.id,
              pinned: !contextGroup!.pinned,
            });
        void request.then(() => refreshBots());
      }}
      onToggleUnread={() => {
        const unread = !contextChat.unread;
        onClose();
        if (contextBot) {
          const request = unread ? markBotUnread(contextBot.id) : markBotRead(contextBot.id);
          void request.catch(() => undefined);
        } else {
          const request = unread
            ? rpc.threads.markUnread({ groupId: contextGroup!.id })
            : rpc.threads.markRead({ groupId: contextGroup!.id });
          void request
            .then(() =>
              setGroups((current) =>
                current.map((group) =>
                  group.id === contextGroup!.id ? { ...group, unread } : group,
                ),
              ),
            )
            .catch(() => undefined);
        }
      }}
      onMoveToSection={(sectionId) => {
        onClose();
        if (sectionId === contextChat.sectionId) return;
        const request = contextBot
          ? rpc.bots.update({ botId: contextBot.id, sectionId })
          : rpc.groups.update({ groupId: contextGroup!.id, sectionId });
        void request.then(() => refreshBots());
      }}
      onCreateSection={() => {
        setNewSectionTarget(
          contextBot ? { kind: "bot", chat: contextBot } : { kind: "group", chat: contextGroup! },
        );
        onClose();
      }}
      onRenameSection={(sectionId) => {
        const section = botSections.find((item) => item.id === sectionId);
        if (section) setRenameSectionTarget({ section });
        onClose();
      }}
      onEdit={() => {
        const destKey =
          userId && spaceId
            ? rightPanelStorageKey(userId, spaceId, contextBot ? "bot" : "group", contextChat.id)
            : null;
        beginExplicitPanel(destKey);
        navigate(contextBot ? `/app/${contextBot.id}` : `/app/g/${contextGroup!.id}`);
        // Mark the destination key restored so we do not write settings onto the source chat.
        showPanel(contextBot ? "settings" : "group-settings", destKey);
        onClose();
      }}
      onDuplicate={() => {
        onClose();
        const request = contextBot
          ? rpc.bots.duplicate({ botId: contextBot.id })
          : rpc.groups.duplicate({ groupId: contextGroup!.id });
        void request.then(async (chat) => {
          await refreshBots();
          navigate(contextBot ? `/app/${chat.id}` : `/app/g/${chat.id}`);
        });
      }}
      onClear={() => {
        setClearTarget(
          contextBot ? { kind: "bot", chat: contextBot } : { kind: "group", chat: contextGroup! },
        );
        onClose();
      }}
      onArchive={() => {
        onClose();
        const request = contextBot
          ? rpc.bots.archive({ botId: contextBot.id })
          : rpc.groups.archive({ groupId: contextGroup!.id });
        void request.then(() => refreshBots(true));
      }}
      onDelete={() => {
        if (contextBot) setDeleteTarget(contextBot);
        else setDeleteGroupTarget(contextGroup!);
        onClose();
      }}
    />
  );
}
