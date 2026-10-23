import { Trans } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { Suspense } from "react";
import { lazyOverlay } from "../../components/ErrorBoundary";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { CommandPalette } from "./command-palette";
import type { ChatTarget, SectionTarget } from "./dialog-targets";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  NewBotSectionDialog,
  PickerInfoDialog,
  RenameBotSectionDialog,
} from "./dialogs";

const MessagingSettingsOverlay = lazyOverlay(() =>
  import("../MessagingSettingsOverlay").then((module) => module.MessagingSettingsOverlay),
);
const McpServersOverlay = lazyOverlay(() =>
  import("../McpServersOverlay").then((module) => module.McpServersOverlay),
);

export function ShellDialogs({
  rpc,
  setPanel,
  refreshBots,
  deleteTarget,
  setDeleteTarget,
  deleteGroupTarget,
  setDeleteGroupTarget,
  newSectionTarget,
  setNewSectionTarget,
  renameSectionTarget,
  setRenameSectionTarget,
  deleteSectionTarget,
  setDeleteSectionTarget,
  commandPaletteOpen,
  setCommandPaletteOpen,
  bots,
  onSelectBot,
  groupInfoOpen,
  setGroupInfoOpen,
  clearTarget,
  setClearTarget,
  confirmClear,
  deleteRoutineDialogProps,
  mcpOpen,
  setMcpOpen,
  messagingSettingsOpen,
  setMessagingSettingsOpen,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  setPanel: (panel: Panel) => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  deleteTarget: Bot | null;
  setDeleteTarget: (bot: Bot | null) => void;
  deleteGroupTarget: Group | null;
  setDeleteGroupTarget: (group: Group | null) => void;
  newSectionTarget: ChatTarget | null;
  setNewSectionTarget: (target: ChatTarget | null) => void;
  renameSectionTarget: SectionTarget | null;
  setRenameSectionTarget: (target: SectionTarget | null) => void;
  deleteSectionTarget: SectionTarget | null;
  setDeleteSectionTarget: (target: SectionTarget | null) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  bots: Bot[];
  onSelectBot: (id: string) => void;
  groupInfoOpen: boolean;
  setGroupInfoOpen: (open: boolean) => void;
  clearTarget: ChatTarget | null;
  setClearTarget: (target: ChatTarget | null) => void;
  confirmClear: (target: ChatTarget) => Promise<void>;
  deleteRoutineDialogProps: ComponentProps<typeof DeleteItemDialog> | null | undefined;
  mcpOpen: boolean;
  setMcpOpen: (open: boolean) => void;
  messagingSettingsOpen: boolean;
  setMessagingSettingsOpen: (open: boolean) => void;
}) {
  return (
    <Suspense fallback={null}>
      {deleteTarget ? (
        <DeleteBotDialog
          bot={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (deleteMemories) => {
            await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
            setDeleteTarget(null);
            setPanel(null);
            await refreshBots(true);
          }}
        />
      ) : null}

      {deleteGroupTarget ? (
        <DeleteItemDialog
          item={deleteGroupTarget}
          noun="group"
          onCancel={() => setDeleteGroupTarget(null)}
          onConfirm={async () => {
            await rpc.groups.remove({ groupId: deleteGroupTarget.id });
            setDeleteGroupTarget(null);
            setPanel(null);
            await refreshBots(true);
          }}
        />
      ) : null}

      {newSectionTarget ? (
        <NewBotSectionDialog
          bot={newSectionTarget.chat}
          onCancel={() => setNewSectionTarget(null)}
          onConfirm={async (name) => {
            await rpc.botSections.create(
              newSectionTarget.kind === "bot"
                ? { botId: newSectionTarget.chat.id, name }
                : { groupId: newSectionTarget.chat.id, name },
            );
            setNewSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {renameSectionTarget ? (
        <RenameBotSectionDialog
          section={renameSectionTarget.section}
          onCancel={() => setRenameSectionTarget(null)}
          onConfirm={async (name) => {
            await rpc.botSections.update({
              sectionId: renameSectionTarget.section.id,
              name,
            });
            setRenameSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {deleteSectionTarget ? (
        <DeleteItemDialog
          item={deleteSectionTarget.section}
          noun="section"
          description={<Trans>Its bots and groups are kept and leave the section.</Trans>}
          onCancel={() => setDeleteSectionTarget(null)}
          onConfirm={async () => {
            await rpc.botSections.remove({ sectionId: deleteSectionTarget.section.id });
            setDeleteSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        bots={bots}
        onSelectBot={onSelectBot}
      />

      {groupInfoOpen ? <PickerInfoDialog onClose={() => setGroupInfoOpen(false)} /> : null}

      {clearTarget ? (
        <ClearConversationDialog
          bot={clearTarget.chat}
          onCancel={() => setClearTarget(null)}
          onConfirm={() => confirmClear(clearTarget)}
        />
      ) : null}

      {deleteRoutineDialogProps ? <DeleteItemDialog {...deleteRoutineDialogProps} /> : null}

      {mcpOpen ? <McpServersOverlay onClose={() => setMcpOpen(false)} /> : null}
      {messagingSettingsOpen ? (
        <MessagingSettingsOverlay onClose={() => setMessagingSettingsOpen(false)} />
      ) : null}
    </Suspense>
  );
}
