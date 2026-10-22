import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { BotAvatar, GroupAvatar } from "@rakazo/ui-web";
import { Menu, Monitor } from "lucide-react";
import { IconTooltip } from "../../components/IconTooltip";
import type { Panel } from "../../lib/right-panel-state";

export function ShellMainHeader({
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  panel,
  setPanel,
  setMobileSidebarOpen,
  refreshThread,
}: {
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  refreshThread: (id: string) => Promise<unknown>;
}) {
  const { t } = useLingui();
  return (
    <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-[17px] md:px-[22px]">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-label={t`Open navigation`}
          onClick={() => setMobileSidebarOpen(true)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-foreground/75 hover:bg-accent md:hidden"
        >
          <Menu size={19} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          data-testid="bot-settings-trigger"
          onClick={() => setPanel(inGroup ? "group-settings" : "settings")}
          className="flex min-w-0 items-center gap-3"
        >
          {inGroup ? (
            <GroupAvatar
              members={activeSnapshot?.members ?? activeGroup?.members ?? []}
              size={26}
            />
          ) : active ? (
            <BotAvatar color={active.color} identity={active.id} size={26} status={active.status} />
          ) : null}
          <span className="min-w-0">
            <span className="block truncate text-[16px] font-medium text-foreground" dir="auto">
              {inGroup
                ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                : (active?.name ?? t`Select a bot`)}
            </span>
          </span>
        </button>
      </div>
      <div className="flex items-center gap-1">
        {!inGroup && active ? (
          <IconTooltip label={t`Agent computer`}>
            <button
              type="button"
              aria-label={t`Agent computer`}
              aria-pressed={panel === "computer"}
              onClick={() => {
                const next = panel === "computer" ? null : "computer";
                setPanel(next);
                if (next === "computer" && active) {
                  // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                  void refreshThread(active.id).catch(() => undefined);
                }
              }}
              data-active={panel === "computer" ? "" : undefined}
              className="grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
            >
              <Monitor size={18} strokeWidth={1.6} className="text-foreground/75" />
            </button>
          </IconTooltip>
        ) : null}
      </div>
    </div>
  );
}
