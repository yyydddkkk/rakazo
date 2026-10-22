import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, SearchHit } from "@rakazo/contracts";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Sidebar,
} from "@rakazo/ui-web";
import { Search, SlidersHorizontal } from "lucide-react";
import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import { SidebarFooter } from "../../components/SidebarFooter";
import type { ActivityListFilters } from "../../lib/activity-list-filters";
import type { BotsSidebarDensity } from "../../lib/bots-sidebar-density-pref";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { clearSpaceSelection } from "../../lib/rpc";
import { useSignOut } from "../../lib/sign-out";
import { ActivityList } from "../ActivityList";
import type { SettingsSection } from "../SettingsOverlay";
import { SpaceSearchResults } from "../SpaceSearch";
import { ArchivedChats } from "./archived-chats";
import { SidebarHeader } from "./sidebar-header";
import { SidebarRoster } from "./sidebar-roster";

type RosterProps = Omit<ComponentProps<typeof SidebarRoster>, "mini" | "botsSidebarDensity">;

export function ShellSidebar({
  rpc,
  isMobileSidebar,
  mobileSidebarOpen,
  setMobileSidebarOpen,
  botsSidebarDensity,
  botsSidebarCollapsed,
  miniSidebar,
  setBotsSidebarCollapsedPref,
  activityMode,
  toggleActivityMode,
  activityFilters,
  setActivityFilters,
  activityFiltersExpanded,
  setActivityFiltersExpanded,
  activityFiltersId,
  activityFilterCount,
  query,
  setQuery,
  bots,
  setPanel,
  navigate,
  setPickerInfoTopic,
  showSpaceSearch,
  searchHits,
  searchLoading,
  jumpToSearchHit,
  archivedBots,
  archivedGroups,
  refreshBots,
  setDeleteTarget,
  setDeleteGroupTarget,
  footerLogos,
  userName,
  initials,
  userImage,
  userEmail,
  ticketBoardEnabled,
  setPluginsOpen,
  openSettings,
  ...rosterProps
}: RosterProps & {
  rpc: ReturnType<typeof createSpaceRpc>;
  isMobileSidebar: boolean;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
  botsSidebarDensity: BotsSidebarDensity;
  botsSidebarCollapsed: boolean;
  miniSidebar: boolean;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  activityMode: boolean;
  toggleActivityMode: () => void;
  activityFilters: ActivityListFilters;
  setActivityFilters: (filters: ActivityListFilters) => void;
  activityFiltersExpanded: boolean;
  setActivityFiltersExpanded: Dispatch<SetStateAction<boolean>>;
  activityFiltersId: string;
  activityFilterCount: number;
  query: string;
  setQuery: (query: string) => void;
  bots: Bot[];
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setPickerInfoTopic: (topic: "group") => void;
  showSpaceSearch: boolean;
  searchHits: SearchHit[];
  searchLoading: boolean;
  jumpToSearchHit: (hit: SearchHit) => Promise<void>;
  archivedBots: Bot[];
  archivedGroups: Group[];
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  setDeleteTarget: (bot: Bot) => void;
  setDeleteGroupTarget: (group: Group) => void;
  footerLogos: Array<{ name: string; logo: string | null }>;
  userName: string;
  initials: string | null;
  userImage: string | null | undefined;
  userEmail: string | undefined;
  ticketBoardEnabled: boolean | undefined;
  setPluginsOpen: (open: boolean) => void;
  openSettings: (section?: SettingsSection) => void;
}) {
  const { t } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logOutError, setLogOutError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut(() => {
    clearSpaceSelection();
    navigate("/");
  }, setLogOutError);
  return (
    <>
      <button
        type="button"
        aria-label={t`Close navigation`}
        aria-hidden={mobileSidebarOpen ? undefined : true}
        inert={mobileSidebarOpen ? undefined : true}
        tabIndex={mobileSidebarOpen ? undefined : -1}
        onClick={() => setMobileSidebarOpen(false)}
        className={`absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-overlay transition-opacity duration-150 ease-out motion-reduce:transition-none md:hidden ${
          mobileSidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <Sidebar
        collapsible={isMobileSidebar ? "none" : "icon"}
        side={document.documentElement.dir === "rtl" ? "right" : "left"}
        data-testid="bots-sidebar"
        inert={isMobileSidebar && !mobileSidebarOpen ? true : undefined}
        aria-hidden={isMobileSidebar && !mobileSidebarOpen ? true : undefined}
        data-bots-sidebar-density={botsSidebarDensity}
        data-collapsed={botsSidebarCollapsed ? "true" : "false"}
        className={
          isMobileSidebar
            ? `absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-transform duration-200 ease-out motion-reduce:transition-none ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"}`
            : "h-full overflow-hidden border-sidebar-border"
        }
      >
        <SidebarHeader
          mini={miniSidebar}
          activityMode={activityMode}
          toggleActivityMode={() => {
            if (miniSidebar) setBotsSidebarCollapsedPref(false);
            toggleActivityMode();
          }}
          setBotsSidebarCollapsedPref={setBotsSidebarCollapsedPref}
          bots={bots}
          setMobileSidebarOpen={setMobileSidebarOpen}
          setPanel={setPanel}
          navigate={navigate}
          setPickerInfoTopic={setPickerInfoTopic}
        />
        {miniSidebar ? (
          <IconTooltip label={t`Search`}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Search`}
              className="mx-auto mb-3"
              onClick={() => {
                setBotsSidebarCollapsedPref(false);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLInputElement>('input[name="sidebar-search"]')?.focus(),
                );
              }}
            >
              <Search size={16} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : (
          <InputGroup
            data-testid="sidebar-search"
            className="mx-2.5 mb-3 w-auto rounded-xl bg-card dark:bg-input border border-border text-muted-foreground focus-within:border-ring"
          >
            <InputGroupAddon>
              <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={activityMode ? activityFilters.query : query}
              onChange={(e) => {
                if (activityMode) setActivityFilters({ ...activityFilters, query: e.target.value });
                else setQuery(e.target.value);
              }}
              onKeyDown={(event) => {
                if (activityMode && event.key === "Escape") {
                  setActivityFilters({ ...activityFilters, query: "" });
                }
              }}
              placeholder={activityMode ? t`Search runs` : t`Search`}
              aria-label={activityMode ? t`Search runs` : t`Search`}
              autoComplete="off"
              name="sidebar-search"
            />
            {activityMode ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-sm"
                  aria-label={t`Filters`}
                  aria-expanded={activityFiltersExpanded}
                  aria-controls={activityFiltersId}
                  onClick={() => setActivityFiltersExpanded((expanded) => !expanded)}
                  className="relative rounded-lg"
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  {activityFilterCount > 0 ? (
                    <span
                      data-testid="activity-filter-indicator"
                      aria-hidden="true"
                      className="absolute end-1 top-1 size-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        )}
        <div className="rk-scroll scroll-fade-y scroll-fade-12 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
          {showSpaceSearch && !miniSidebar ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              onSelect={(hit) => void jumpToSearchHit(hit)}
            />
          ) : (
            <>
              {activityMode && !miniSidebar ? (
                <ActivityList
                  filters={activityFilters}
                  onFiltersChange={setActivityFilters}
                  filtersExpanded={activityFiltersExpanded}
                  filtersId={activityFiltersId}
                  onOpenRun={(run) => {
                    setMobileSidebarOpen(false);
                    if (run.groupId) navigate(`/app/g/${run.groupId}`);
                    else navigate(`/app/${run.botId}`);
                  }}
                />
              ) : null}
              <SidebarRoster
                {...rosterProps}
                mini={miniSidebar}
                botsSidebarDensity={botsSidebarDensity}
              />
            </>
          )}
          <div className={miniSidebar ? "hidden" : "contents"}>
            <ArchivedChats
              archivedBots={archivedBots}
              archivedGroups={archivedGroups}
              showSpaceSearch={showSpaceSearch}
              rpc={rpc}
              refreshBots={refreshBots}
              setDeleteTarget={setDeleteTarget}
              setDeleteGroupTarget={setDeleteGroupTarget}
            />
          </div>
        </div>
        <div className={miniSidebar ? "hidden" : "contents"}></div>
        <SidebarFooter
          mini={miniSidebar}
          logos={footerLogos}
          name={userName}
          initials={initials}
          image={userImage}
          email={userEmail}
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) setLogOutError(null);
          }}
          onIntegrations={() => {
            setMenuOpen(false);
            setPluginsOpen(true);
          }}
          onBoard={
            ticketBoardEnabled
              ? () => {
                  setMenuOpen(false);
                  setMobileSidebarOpen(false);
                  navigate("/app/board");
                }
              : undefined
          }
          onArtifacts={() => {
            setMenuOpen(false);
            setMobileSidebarOpen(false);
            navigate("/app/artifacts");
          }}
          onSettings={() => {
            setMenuOpen(false);
            openSettings("general");
          }}
          onUsage={() => {
            setMenuOpen(false);
            openSettings("usage");
          }}
          onLogOut={() => {
            setLogOutError(null);
            void logOut();
          }}
          signingOut={signingOut}
          logOutError={logOutError}
        />
      </Sidebar>
    </>
  );
}
