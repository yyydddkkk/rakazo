import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerStatus,
  Group,
  Me,
  Routine,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { isActive } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Settings, X } from "lucide-react";
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import { ComputerMaintenanceActions } from "../../components/ComputerMaintenanceActions";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { computerPanelNeedsMaintenance } from "../../lib/thread-events";
import { CreateGroupForm, GroupSettings } from "../GroupPanel";
import { ResizableSidePanel } from "../ResizableSidePanel";
import { RoutineEditor } from "../RoutineEditor";
import type { SettingsSection } from "../SettingsOverlay";
import { BotSettings, CreateBotForm } from "./bot-panel";
import { ComputerPanel } from "./computer-panel";
import type { ChatTarget } from "./dialog-targets";
import { firstThreadRoute } from "./thread-helpers";

export function ShellSidePanel({
  rpc,
  panel,
  setPanel,
  active,
  activeGroup,
  bots,
  setBots,
  groups,
  setGroups,
  snapshot,
  computer,
  computerOpen,
  booting,
  embeddedScreenUrl,
  setScreenFrame,
  computerScreenError,
  computerBooting,
  showingRecoveryHint,
  showComputerRecoveryHint,
  bootstrapMe,
  setBootstrapMe,
  holdComputerRecovery,
  releaseComputerRecovery,
  openSettings,
  openComputer,
  activeRoutines,
  startRoutine,
  stopRun,
  routineEditorProps,
  refreshThread,
  refreshGroupThread,
  refreshBots,
  createGroup,
  createBot,
  openBot,
  navigate,
  setAgentSkills,
  setClearTarget,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  bots: Bot[];
  setBots: Dispatch<SetStateAction<Bot[]>>;
  groups: Group[];
  setGroups: Dispatch<SetStateAction<Group[]>>;
  snapshot: ThreadSnapshot | null;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  booting: boolean;
  embeddedScreenUrl: string | null;
  setScreenFrame: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  showingRecoveryHint: boolean;
  showComputerRecoveryHint: boolean;
  bootstrapMe: Me | null | undefined;
  setBootstrapMe: Dispatch<SetStateAction<Me | null | undefined>>;
  holdComputerRecovery: () => void;
  releaseComputerRecovery: () => void;
  openSettings: (section?: SettingsSection) => void;
  openComputer: () => Promise<boolean>;
  activeRoutines: Routine[];
  startRoutine: (routine?: Routine) => void;
  stopRun: () => Promise<void>;
  routineEditorProps: ComponentProps<typeof RoutineEditor> | null | undefined;
  refreshThread: (id: string) => Promise<unknown>;
  refreshGroupThread: (id: string) => Promise<unknown>;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  createGroup: (input: { name: string; botIds: string[] }) => Promise<void>;
  createBot: ComponentProps<typeof CreateBotForm>["onCreate"];
  openBot: (id: string) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  setAgentSkills: (skills: AgentSkillCatalogEntry[]) => void;
  setClearTarget: (target: ChatTarget) => void;
}) {
  const { t } = useLingui();
  return (
    <ResizableSidePanel
      open={Boolean(panel && (active || activeGroup || panel === "create"))}
      panel={panel ?? "closed"}
    >
      {panel && (active || activeGroup || panel === "create") ? (
        <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px]">
          {panel !== "routine" &&
          panel !== "create" &&
          panel !== "create-group" &&
          panel !== "group-settings" ? (
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[13.5px] text-muted-foreground">
                {panel === "settings" ? (
                  <Trans>Settings</Trans>
                ) : active ? (
                  (computer?.state ?? active.status)
                ) : (
                  <Trans>Group</Trans>
                )}
              </span>
              <div className="flex gap-1">
                {active &&
                panel === "computer" &&
                !computerOpen &&
                computerPanelNeedsMaintenance(computer?.state, booting) ? (
                  <ComputerMaintenanceActions
                    botId={active.id}
                    computer={computer}
                    onChanged={async () => {
                      await refreshThread(active.id);
                    }}
                  />
                ) : null}
                {active ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={panel === "settings" ? t`Show computer` : t`Show settings`}
                    onClick={() => setPanel(panel === "settings" ? "computer" : "settings")}
                    className={panel === "settings" ? "text-foreground" : "text-muted-foreground"}
                  >
                    <Settings size={16} strokeWidth={1.7} />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Close panel`}
                  onClick={() => setPanel(null)}
                >
                  <X size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </div>
          ) : null}
          {panel === "computer" && active ? (
            <ComputerPanel
              bot={active}
              computer={computer}
              computerOpen={computerOpen}
              embeddedScreenUrl={embeddedScreenUrl}
              screenFrameRef={setScreenFrame}
              computerScreenError={computerScreenError}
              computerBooting={computerBooting}
              booting={booting}
              showingRecoveryHint={showingRecoveryHint}
              showComputerRecoveryHint={showComputerRecoveryHint}
              sandboxProvider={bootstrapMe?.sandboxProvider}
              onRecovered={(sandboxProvider) => {
                setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev));
                holdComputerRecovery();
              }}
              onRecoveryDismissed={releaseComputerRecovery}
              onOpenComputerSettings={
                bootstrapMe?.isDeploymentOwner === true ? () => openSettings("computer") : undefined
              }
              onOpen={() => void openComputer()}
              routines={activeRoutines}
              runningRoutineId={
                snapshot?.run && isActive(snapshot.run.status)
                  ? (snapshot.run.routineId ?? undefined)
                  : undefined
              }
              onCreateRoutine={() => startRoutine()}
              onEditRoutine={startRoutine}
              onStopRun={() => void stopRun()}
            />
          ) : null}
          {panel === "create-group" ? (
            <CreateGroupForm
              bots={bots}
              onCancel={() => setPanel(null)}
              onCreate={(input) => createGroup(input)}
              onOpenBot={(botId) => {
                setPanel(null);
                openBot(botId);
              }}
            />
          ) : null}
          {panel === "group-settings" && activeGroup ? (
            <GroupSettings
              key={activeGroup.id}
              group={activeGroup}
              bots={bots}
              onSave={async (input) => {
                const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
                setGroups((current) =>
                  current.map((group) => (group.id === updated.id ? updated : group)),
                );
                void Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                  () => undefined,
                );
              }}
              onRemove={async () => {
                await rpc.groups.remove({ groupId: activeGroup.id });
                const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
                setGroups(remainingGroups);
                setPanel(null);
                navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
                await refreshBots().catch(() => undefined);
              }}
              onClose={() => setPanel(null)}
              onOpenBot={openBot}
              covered={computerOpen}
            />
          ) : null}
          {panel === "create" ? (
            <CreateBotForm onCancel={() => setPanel(null)} onCreate={(input) => createBot(input)} />
          ) : null}
          {panel === "settings" && active ? (
            <BotSettings
              key={active.id}
              bot={active}
              onSkillsChange={setAgentSkills}
              onSave={async ({ computerMode, ...patch }) => {
                if (computerMode !== undefined && computerMode !== active.computerMode) {
                  await rpc.bots.setComputer({
                    botId: active.id,
                    mode: computerMode,
                  });
                }
                const updated = await rpc.bots.update({ botId: active.id, ...patch });
                setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)));
                // Persistence succeeded; a failed navigation refresh must not undo the tool edit.
                await refreshBots().catch(() => undefined);
              }}
              onExport={async () => {
                const manifest = await rpc.export.bot({ botId: active.id });
                const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              onClear={() => setClearTarget({ kind: "bot", chat: active })}
            />
          ) : null}
          {panel === "routine" && routineEditorProps ? (
            <RoutineEditor {...routineEditorProps} />
          ) : null}
        </div>
      ) : null}
    </ResizableSidePanel>
  );
}
