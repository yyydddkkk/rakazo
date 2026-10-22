import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotSection,
  ComputerMode,
  ComputerReleaseReason,
  ComputerStatus,
  Group,
  Me,
  Routine,
  SearchHit,
  Space,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { normalizeCreateBotProfile } from "@rakazo/contracts";
import {
  accountDisplay,
  answerableAskMessageIds,
  attachmentsForThread,
  buildComposerMentionOptions,
  dismissableAskMessageIds,
  foldPeerReplies,
  isActive,
  isRetryableError,
  isRunTerminalEvent,
  isRunWorking,
  runThreadSubscription,
  searchHitThreadTarget,
  withLiveStreamingProgress,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { AvatarStyleProvider, Button } from "@rakazo/ui-web";
import { useIsMobile } from "@rakazo/ui-web/hooks/use-mobile";
import { Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import type { ArtifactTarget } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { takeInitialBootstrap } from "../lib/bootstrap";
import type { BotsSidebarDensity } from "../lib/bots-sidebar-density-pref";
import {
  getBotsSidebarDensity,
  subscribeBotsSidebarDensity,
} from "../lib/bots-sidebar-density-pref";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../lib/bots-sidebar-pref";
import { setComposerUnsavedWork } from "../lib/composer-draft";
import {
  getComposerEnterToSend,
  subscribeComposerEnterToSend,
} from "../lib/composer-enter-to-send-pref";
import { bootComputerOnce, embeddableScreenUrl, loadComputerScreen } from "../lib/computer-screen";
import { scheduleFocusPrompt } from "../lib/focus-prompt";
import { localTimezone } from "../lib/local-timezone";
import {
  revokePendingAttachmentPreviews,
  usePendingAttachmentPreviewCleanup,
} from "../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../lib/performance";
import { usePreloadRecoveryState } from "../lib/preload-recovery";
import { getResponseStreamingEnabled, subscribeResponseStreaming } from "../lib/response-streaming";
import type { Panel, RightPanelState } from "../lib/right-panel-state";
import {
  readRightPanelState,
  rightPanelStorageKey,
  writeRightPanelState,
} from "../lib/right-panel-state";
import { createSpaceRpc, selectedSpaceId } from "../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../lib/run-error-storage";
import { guardShellNavigate } from "../lib/shell-navigation";
import {
  activeThreadRuns,
  computerPanelNeedsScreen,
  computerTakeoverBlocked,
  isComputerStatusEvent,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  threadRunError,
  userHoldsComputerControl,
} from "../lib/thread-events";
import { getToolActivityEnabled, subscribeToolActivity } from "../lib/tool-activity-preference";
import { transcriptCanSnapAfterFrame, transcriptIsNearEnd } from "../lib/transcript-scroll";
import { errorText } from "../lib/user-error";
import { memberName } from "./GroupPanel";
import type { SettingsSection } from "./SettingsOverlay";
import { BotContextMenuContent } from "./shell/bot-context-menu-content";
import type { PendingAttachment } from "./shell/chat-shared";
import { FALLBACK_BOT_COLOR } from "./shell/chat-shared";
import { Composer } from "./shell/composer";
import { ComputerOverlay } from "./shell/computer-overlay";
import { ComputerBootingStatus, ComputerScreenError } from "./shell/computer-screen-status";
import type { ChatTarget, SectionTarget } from "./shell/dialog-targets";
import { ShellDialogs } from "./shell/shell-dialogs";
import { ShellMainHeader } from "./shell/shell-main-header";
import { ShellSettingsOverlays } from "./shell/shell-settings-overlays";
import { ShellSidePanel } from "./shell/shell-side-panel";
import { ShellSidebar } from "./shell/shell-sidebar";
import { BotsSidebarLayout } from "./shell/sidebar-layout";
import { sidebarGroupsForSpaces } from "./shell/space-sidebar";
import { applyThreadEvent, firstThreadRoute, threadSnapshotSignal } from "./shell/thread-helpers";
import { Transcript } from "./shell/transcript";
import { useActivityMode } from "./shell/use-activity-mode";
import { useBotReadState } from "./shell/use-bot-read-state";
import { useBrowserNotifications } from "./shell/use-browser-notifications";
import { useComposerActions } from "./shell/use-composer-actions";
import { useComputerRecoveryHold } from "./shell/use-computer-recovery-hold";
import { useComputerScreenFrame, useComputerViewport } from "./shell/use-computer-screen-frame";
import { useMentionSources } from "./shell/use-mention-sources";
import { useMobileSidebar } from "./shell/use-mobile-sidebar";
import { useRosterReorder } from "./shell/use-roster-reorder";
import { useRoutineEditor } from "./shell/use-routine-editor";
import { useSettingsStatus } from "./shell/use-settings-status";
import { useShellHotkeys } from "./shell/use-shell-hotkeys";
import { useSidebarExpansion } from "./shell/use-sidebar-expansion";
import { useSpaceSearch } from "./shell/use-space-search";

export function ShellPage() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const [rpc] = useState(() => createSpaceRpc(selectedSpaceId()));
  const routerNavigate = useNavigate();
  const navigateRef = useRef(routerNavigate);
  navigateRef.current = routerNavigate;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const navigate = useMemo(
    () =>
      guardShellNavigate(
        () => navigateRef.current,
        () => alive.current,
      ),
    [],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect below, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [groups, setGroups] = useState<Group[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botOrderEpochRef = useRef(0);
  const pendingBotOrderRef = useRef<string[] | null>(null);
  const savingBotOrderRef = useRef(false);
  const [botSections, setBotSections] = useState<BotSection[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [archivedBots, setArchivedBots] = useState<Bot[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<Group[]>([]);
  const {
    collapsedSidebarSections,
    collapsedRosterParents,
    toggleSidebarSection,
    toggleRosterParent,
  } = useSidebarExpansion(userId);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const showToolActivity = useSyncExternalStore(
    subscribeToolActivity,
    getToolActivityEnabled,
    () => true,
  );
  const botsSidebarDensity = useSyncExternalStore<BotsSidebarDensity>(
    subscribeBotsSidebarDensity,
    getBotsSidebarDensity,
    () => "comfortable",
  );
  const enterToSend = useSyncExternalStore(
    subscribeComposerEnterToSend,
    getComposerEnterToSend,
    () => false,
  );
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  usePendingAttachmentPreviewCleanup(pendingAttachments);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setComposerUnsavedWork(sending || pendingAttachments.length > 0);
    return () => setComposerUnsavedWork(false);
  }, [sending, pendingAttachments.length]);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanelState] = useState<Panel>(null);
  const [restoredPanelKey, setRestoredPanelKey] = useState<string | null>(null);
  const panelStorageKeyRef = useRef<string | null>(null);
  const observedPanelKey = useRef<string | null>(null);
  const explicitPanelTarget = useRef<string | null>(null);
  const pendingPanelRestore = useRef<RightPanelState | null>(null);
  const pendingExplicitPanel = useRef(false);
  const panelSearch = useRef({ searchParams, setSearchParams });
  panelSearch.current = { searchParams, setSearchParams };
  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    // A user navigation wins over a saved routine still waiting for its list.
    pendingPanelRestore.current = null;
    pendingExplicitPanel.current = panelStorageKeyRef.current === null;
    setRestoredPanelKey(panelStorageKeyRef.current);
    setPanelState(next);
    const currentSearch = panelSearch.current;
    if (currentSearch.searchParams.has("routine")) {
      const params = new URLSearchParams(currentSearch.searchParams);
      params.delete("routine");
      currentSearch.setSearchParams(params, { replace: true });
    }
  }, []);
  const [peerConversation, setPeerConversation] = usePreloadRecoveryState<{
    peerBotId: string;
    peerBotName: string;
  } | null>("peerConversation", null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [teachBusy, setTeachBusy] = useState(false);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  const threadRefreshEpoch = useRef(0);
  const groupRefreshEpoch = useRef(0);
  const botsRefreshEpoch = useRef(0);
  const botsRefreshApplied = useRef(0);
  const archivedBotsRefreshEpoch = useRef(0);
  const botsRefreshInFlight = useRef(0);
  // A very fast run can finish over SSE while its threads.send response is still
  // returning. Do not let that late receipt resurrect terminal work as queued.
  const terminalRunReceipts = useRef(new Set<string>());
  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(
    new Map<string, { computer: ComputerStatus | null; screenUrl: string | null }>(),
  );
  // Caps computerCacheRef so a long session that opens many distinct bots
  // over time doesn't accumulate one entry per bot forever. Re-inserting on
  // every update keeps Map iteration order as least-recently-used first, so
  // eviction drops the bot that's been out of view longest.
  const COMPUTER_CACHE_LIMIT = 20;

  function cacheComputerFor(
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screenUrl: string | null }>,
  ) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null, screenUrl: null };
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function commitSnapshot(next: ThreadSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function commitComputer(next: ComputerStatus | null) {
    computerRef.current = next;
    setComputer(next);
  }

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }
  const [pluginsOpen, setPluginsOpen] = usePreloadRecoveryState("integrations", false);
  const [mcpOpen, setMcpOpen] = usePreloadRecoveryState("mcp", false);
  const [settingsOpen, setSettingsOpen] = usePreloadRecoveryState("settings", false);
  const [settingsSection, setSettingsSection] = usePreloadRecoveryState<SettingsSection>(
    "settingsSection",
    "general",
  );
  const [messagingSettingsOpen, setMessagingSettingsOpen] = usePreloadRecoveryState(
    "messaging",
    false,
  );
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const { mobileSidebarOpen, setMobileSidebarOpen, swipeHandlers } = useMobileSidebar();
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);
  const isMobileSidebar = useIsMobile();
  const miniSidebar = botsSidebarCollapsed && !isMobileSidebar;
  const [pickerInfoTopic, setPickerInfoTopic] = useState<"group" | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const {
    activityMode,
    activityFilters,
    setActivityFilters,
    activityFiltersExpanded,
    setActivityFiltersExpanded,
    activityFiltersId,
    activityFilterCount,
    toggleActivityMode,
  } = useActivityMode(setQuery);
  const [botMenu, setBotMenu] = useState<{ kind: "bot" | "group"; id: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [clearTarget, setClearTarget] = useState<ChatTarget | null>(null);
  const [newSectionTarget, setNewSectionTarget] = useState<ChatTarget | null>(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<SectionTarget | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<SectionTarget | null>(null);
  // The bot whose boot shows progress, and every bot whose boot request is still out.
  const [bootingBotId, setBootingBotId] = useState<string | null>(null);
  const booting = bootingBotId !== null && bootingBotId === computer?.botId;
  const bootsInFlight = useRef(new Map<string, symbol>());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();
  const settingsSpace = spaces.find((space) => space.id === bootstrapMe?.spaceId) ?? null;
  const { showComputerRecoveryHint, holdComputerRecovery, releaseComputerRecovery } =
    useComputerRecoveryHold(bootstrapMe?.sandboxProvider, panel);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerBotId, setComputerBotId] = useState<string | undefined>();
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef<string | undefined>(undefined);
  const computerBootEpoch = useRef(0);
  const openComputerRef = useRef<(botId?: string) => Promise<boolean>>(async () => false);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  const computerErrorFromScreenRef = useRef(false);
  computerErrorFromScreenRef.current = computerErrorFromScreen;
  const { setScreenFrame, screenLoadError, setScreenLoadError } = useComputerScreenFrame(screenUrl);
  const computerViewport = useComputerViewport(computerOpen);
  const { messagingSurfaceEnabled, usage, refreshUsage } = useSettingsStatus(
    rpc,
    session.data?.user,
  );
  const autoBooted = useRef<string | null>(null);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{
    messageId: string;
    nonce: number;
  } | null>(null);
  const clearScrollRequest = useCallback(() => setScrollRequest(null), []);
  const initiallyScrolledThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: ThreadMessage[];
    olderCursor: number | null;
  } | null>(null);
  const readVisibleGroups = useRef(new Set<string>());
  const computerVisible = useRef(false);
  computerVisible.current = panel === "computer" || computerOpen;

  const inGroup = Boolean(groupId);
  const active = inGroup ? undefined : (bots.find((b) => b.id === botId) ?? bots[0]);
  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  computerOpenRef.current = computerOpen;
  computerBotIdRef.current = computerBotId ?? active?.id;
  useEffect(() => {
    setScreenLoadError(null);
  }, [computerBot?.id, screenUrl]);
  const activeGroup = groups.find((group) => group.id === groupId);
  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : active?.id),
    [active?.id, groupId, inGroup, pendingAttachments],
  );
  const activeRoutines = !inGroup && routinesBotId === active?.id ? routines : [];
  const panelTarget = inGroup ? activeGroup?.id : active?.id;
  const panelStorageKey =
    userId && bootstrapMe?.spaceId && panelTarget
      ? rightPanelStorageKey(userId, bootstrapMe.spaceId, inGroup ? "group" : "bot", panelTarget)
      : null;
  panelStorageKeyRef.current = panelStorageKey;
  const activeTaughtSkills = taughtSkillsBotId === active?.id ? taughtSkills : [];
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;
  const routeBotId = useRef<string | undefined>(botId);
  routeBotId.current = botId;
  const routeGroupId = useRef<string | undefined>(groupId);
  routeGroupId.current = groupId;
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = groupId;
  const {
    editorProps: routineEditorProps,
    deleteDialogProps: deleteRoutineDialogProps,
    editingRoutine,
    restoreRoutine,
    editRoutine,
    startRoutine,
    resetRoutineTarget,
    leaveRoutine,
    addSkillRoutine,
  } = useRoutineEditor({
    rpc,
    active,
    activeBotId,
    timezone: bootstrapMe?.timezone,
    setBots,
    refreshThread,
    setPanel,
  });
  const screenRequest = useRef(0);
  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const { manuallyUnread, markBotRead, markBotUnread, markBotReadIfVisible } = useBotReadState(
    rpc,
    setBots,
  );
  const { flushPendingBrowserNotifications, notifyBrowserForEvent } =
    useBrowserNotifications(botsRef);

  const refreshBots = useCallback(
    async (includeArchived = false, replaceBotOrder = false) => {
      markOnce("rk:renderer:bots-request-start");
      const request = ++botsRefreshEpoch.current;
      const botOrderEpoch = botOrderEpochRef.current;
      const preserveBotOrder = savingBotOrderRef.current || pendingBotOrderRef.current !== null;
      const archivedRequest = includeArchived ? ++archivedBotsRefreshEpoch.current : null;
      botsRefreshInFlight.current += 1;
      try {
        const [navigation, archived, archivedGroupList] = await Promise.all([
          rpc.spaces.list(),
          includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
          includeArchived ? rpc.groups.listArchived() : Promise.resolve(null),
        ]);
        const { bots: list, botSections: sections, groups: groupList } = navigation.current;
        markOnce("rk:renderer:bots-response");
        const botsFresh = request === botsRefreshEpoch.current;
        const archivedFresh =
          archivedRequest != null && archivedRequest === archivedBotsRefreshEpoch.current;
        // A newer non-archived refresh can win the bots epoch while an older
        // includeArchived request still owns archivedBotsRefreshEpoch — apply
        // whichever slices are still current.
        if (!botsFresh && !archivedFresh) return;
        if (archivedFresh && archived) setArchivedBots(archived);
        if (archivedFresh && archivedGroupList) setArchivedGroups(archivedGroupList);
        if (!botsFresh) return;
        if (
          botOrderEpoch === botOrderEpochRef.current &&
          (replaceBotOrder || (!preserveBotOrder && !savingBotOrderRef.current))
        ) {
          setBots(list);
        }
        setBotSections(sections);
        setGroups(groupList);
        setSpaces(navigation.spaces);
        setInitialBotsLoaded(true);
        botsRefreshApplied.current = request;
        if (
          includeArchived &&
          list.length === 0 &&
          archived?.length === 0 &&
          groupList.length === 0 &&
          archivedGroupList?.length === 0 &&
          !navigation.spaces.some((space) => space.hasContent)
        ) {
          // Only the very first bot everywhere needs onboarding. An empty
          // current space with content elsewhere stays in the app so the
          // space can be switched to or deleted instead of trapping the user.
          navigate("/onboarding", { replace: true });
          return;
        }
        const currentGroupId = routeGroupId.current;
        if (currentGroupId) {
          if (!groupList.some((group) => group.id === currentGroupId)) {
            navigate(firstThreadRoute(list, groupList), { replace: true });
          }
          return;
        }
        const currentBotId = routeBotId.current;
        if (!currentBotId || !list.some((bot) => bot.id === currentBotId)) {
          navigate(firstThreadRoute(list, groupList), { replace: true });
        }
      } finally {
        botsRefreshInFlight.current -= 1;
      }
    },
    [navigate],
  );

  function snapTranscriptToEndAfterFrame() {
    const queuedElement = messageScroll.current;
    if (!queuedElement) return;
    const queuedScrollTop = queuedElement.scrollTop;
    window.requestAnimationFrame(() => {
      const element = messageScroll.current;
      if (transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop)) {
        queuedElement.scrollTop = queuedElement.scrollHeight;
      }
    });
  }

  async function refreshGroupThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const request = ++groupRefreshEpoch.current;
    const snap = await rpc.threads.get({ groupId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (activeGroupId.current !== id || request !== groupRefreshEpoch.current) return snap;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    if (!computerOpenRef.current) commitComputer(null);
    setRoutines([]);
    setRoutinesBotId(null);
    // Keep the search-jump viewport; expandedHistoryThread merge still accepts live messages.
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    return snap;
  }

  async function refreshThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const request = ++threadRefreshEpoch.current;
    // Apply threads.get as soon as it returns so stop/takeover status is not held behind
    // routines/skills/screen fetches (progress can advance the cursor meanwhile).
    const snap = await rpc.threads.get({ botId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (
      activeBotId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== threadRefreshEpoch.current
    ) {
      return snap;
    }
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    commitComputer(reconciled.computer);
    cacheComputerFor(id, { computer: reconciled.computer });
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    void Promise.all([
      rpc.routines.list({ botId: id }).catch(() => null),
      rpc.skills.list({ botId: id }).catch(() => null),
      refreshComputerScreen(id).catch(() => null),
    ]).then(([routines, skills]) => {
      if (
        activeBotId.current !== id ||
        epoch !== historyEpoch.current ||
        request !== threadRefreshEpoch.current
      ) {
        return;
      }
      if (routines) {
        setRoutines(routines);
        setRoutinesBotId(id);
      }
      if (skills) {
        setTaughtSkills(skills);
        setTaughtSkillsBotId(id);
      }
    });
    return snap;
  }

  async function refreshComputerScreen(id: string) {
    if (!computerVisible.current) return null;
    const request = ++screenRequest.current;
    return loadComputerScreen({
      load: () => rpc.computer.screenUrl({ botId: id }),
      isCurrent: () =>
        request === screenRequest.current &&
        (activeBotId.current === id || computerBotIdRef.current === id) &&
        computerVisible.current,
      commit: (screen) => {
        setScreenUrl(screen.url);
        // A screen read replaces only its own error; a failed boot keeps its error and Retry.
        if (screen.error || computerErrorFromScreenRef.current) {
          setComputerError(screen.error);
          setComputerErrorFromScreen(Boolean(screen.error));
        }
        cacheComputerFor(id, { screenUrl: screen.url });
      },
      fallbackError: t`Could not connect to the computer screen`,
    });
  }

  async function loadOlderMessages() {
    const targetBotId = inGroup ? undefined : active?.id;
    const targetGroupId = inGroup ? groupId : undefined;
    const snapshotMatchesTarget = targetGroupId
      ? snapshot?.groupId === targetGroupId
      : snapshot?.botId === targetBotId;
    if (
      (!targetBotId && !targetGroupId) ||
      !snapshotMatchesTarget ||
      snapshot?.olderCursor == null ||
      loadingOlder
    )
      return;
    pinnedAroundRef.current = null;
    const scrollElement = messageScroll.current;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const epoch = historyEpoch.current;
    const before = snapshot.olderCursor;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        before,
      });
      if (
        epoch !== historyEpoch.current ||
        activeBotId.current !== targetBotId ||
        activeGroupId.current !== targetGroupId
      )
        return;
      expandedHistoryThread.current = page.threadId;
      updateSnapshot((prev) => prependThreadMessagePage(prev, page));
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop += element.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const appliedAtStart = botsRefreshApplied.current;
    void takeInitialBootstrap(botId)
      .then((bootstrap) => {
        if (cancelled) return;
        const groupList = bootstrap.groups;
        setBootstrapMe(bootstrap.me);
        // First sign-in with no saved timezone: adopt this browser's, once. A choice made
        // in Settings is never overwritten; a failure just leaves bots on UTC.
        if (bootstrap.me.timezone === null) {
          void rpc.preferences
            .adoptTimezone({ timezone: localTimezone() })
            .then((nextMe) => {
              if (!cancelled) {
                setBootstrapMe((current) =>
                  current && current.timezone == null
                    ? { ...current, timezone: nextMe.timezone }
                    : (current ?? nextMe),
                );
              }
            })
            .catch(() => {});
        }
        // Skip list/route writes only if a later refreshBots() successfully
        // committed (failed refreshes bump epoch but not botsRefreshApplied).
        const applyBotLists = appliedAtStart === botsRefreshApplied.current;
        if (applyBotLists) {
          setBots(bootstrap.bots);
          setBotSections(bootstrap.botSections);
          setArchivedBots(bootstrap.archivedBots);
          setArchivedGroups(bootstrap.archivedGroups);
          setGroups(groupList);
          setSpaces(bootstrap.spaces);
          setInitialBotsLoaded(true);
        }
        if (!groupId && bootstrap.thread) {
          bootstrappedThread.current = bootstrap.thread;
          commitSnapshot(bootstrap.thread);
          commitComputer(bootstrap.thread.computer ?? null);
          setRoutines(bootstrap.routines);
          setRoutinesBotId(bootstrap.thread.botId ?? null);
          markOnce("rk:renderer:bots-response");
          markOnce("rk:renderer:thread-response");
        }
        if (!applyBotLists) return;
        if (
          bootstrap.bots.length === 0 &&
          bootstrap.archivedBots.length === 0 &&
          groupList.length === 0 &&
          bootstrap.archivedGroups.length === 0 &&
          !bootstrap.spaces.some((space) => space.hasContent)
        ) {
          navigate("/onboarding", { replace: true });
          return;
        }
        if (groupId) {
          if (!groupList.some((group) => group.id === groupId)) {
            navigate(firstThreadRoute(bootstrap.bots, groupList), { replace: true });
          }
          return;
        }
        const selectedBotId = bootstrap.thread?.botId ?? bootstrap.bots[0]?.id;
        if (selectedBotId && selectedBotId !== botId) {
          navigate(`/app/${selectedBotId}`, { replace: true });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setBootstrapMe(null);
        void refreshBots(true).catch(() => undefined);
      });
    let refreshTimer: number | undefined;
    const refreshVisibleBots = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(
        () =>
          void refreshBots().catch((error) => {
            if (!isRetryableError(error)) window.clearInterval(poll);
          }),
        50,
      );
    };
    window.addEventListener("focus", refreshVisibleBots);
    document.addEventListener("visibilitychange", refreshVisibleBots);
    // Poll skips while a refresh is in flight; focus/visibility and event-driven
    // callers still bump botsRefreshEpoch so only the latest response applies.
    const poll = window.setInterval(() => {
      if (botsRefreshInFlight.current > 0) return;
      refreshVisibleBots();
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void rpc.agentSkills
      .list()
      .then((skills) => {
        if (!cancelled) setAgentSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAgentSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAgentSkills = useCallback(() => {
    void rpc.agentSkills
      .list()
      .then(setAgentSkills)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active) return;
    // Opening a bot clears the manual unread flag so it can auto-read again.
    manuallyUnread.current.delete(active.id);
    const markVisibleBotRead = () => {
      markBotReadIfVisible(active.id);
    };
    markVisibleBotRead();
    window.addEventListener("focus", markVisibleBotRead);
    document.addEventListener("visibilitychange", markVisibleBotRead);
    return () => {
      window.removeEventListener("focus", markVisibleBotRead);
      document.removeEventListener("visibilitychange", markVisibleBotRead);
    };
  }, [active?.id, markBotReadIfVisible]);

  useEffect(() => {
    if (!active) return;
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
    }
    screenRequest.current += 1;
    setComputerError(null);
    setComputerErrorFromScreen(false);
    const cached = computerCacheRef.current.get(active.id);
    if (cached) {
      // Paint the last-known computer instantly; refreshThread/refreshComputerScreen
      // below still run and reconcile with fresh data in the background.
      setScreenUrl(cached.screenUrl);
      commitComputer(cached.computer);
    } else {
      setScreenUrl(null);
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        const primed = bootstrappedThread.current;
        bootstrappedThread.current = null;
        // Pending search jumps load the around-page separately; avoid replacing it with latest.
        return primed?.botId === active.id
          ? primed
          : pendingJump
            ? rpc.threads.get({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) })
            : refreshThread(active.id, threadSnapshotSignal(abort.signal));
      },
      loadHead: () =>
        rpc.threads.head({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshThread(active.id, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor, signal) =>
        rpc.threads.subscribe({ botId: active.id, cursor }, { signal }),
      beforeEvent: (event) => {
        if (isRunTerminalEvent(event) && event.runId) {
          terminalRunReceipts.current.add(event.runId);
          if (terminalRunReceipts.current.size > 100) {
            const oldest = terminalRunReceipts.current.values().next().value;
            if (oldest !== undefined) terminalRunReceipts.current.delete(oldest);
          }
        }
      },
      applyEvent: (event) =>
        applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef),
      onEvent: (event, initial) => {
        const currentBot = botsRef.current.find((bot) => bot.id === active.id);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          currentBot?.name ?? active.name,
          currentBot?.notifyOnFinish ?? false,
          false,
        );
        if (event.type === "thread.cleared") {
          expandedHistoryThread.current = null;
          pinnedAroundRef.current = null;
          historyEpoch.current += 1;
        }
        if (event.type === "bot.archived") {
          void refreshBots(true).catch(() => undefined);
        } else if (
          event.type === "bot.spawned" ||
          event.type === "bot.deleted" ||
          event.type === "bot.updated" ||
          event.type === "group.created" ||
          event.type === "run.started" ||
          isRunTerminalEvent(event) ||
          event.type === "thread.cleared"
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (event.type === "thread.message.created") {
          const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
          if (blocks.some((block) => block.kind === "child_bot")) {
            void refreshBots().catch(() => undefined);
          }
          if (event.payload.role === "bot") markBotReadIfVisible(active.id);
        }
        if (
          isRunTerminalEvent(event) ||
          event.type === "run.waiting_input" ||
          event.type === "skill.teaching.stopped"
        ) {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void refreshThread(active.id).catch(() => undefined);
        } else if (isComputerStatusEvent(event)) {
          void refreshComputerScreen(active.id).catch(() => undefined);
        }
      },
    });
    return () => {
      abort.abort();
    };
  }, [active?.id, markBotReadIfVisible, notifyBrowserForEvent]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    manuallyUnread.current.delete(activeGroup.id);
    readVisibleGroups.current.delete(groupId);
    const markVisibleGroupRead = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        readVisibleGroups.current.has(groupId)
      )
        return;
      readVisibleGroups.current.add(groupId);
      void rpc.threads
        .markRead({ groupId })
        .then(() => {
          setGroups((current) => {
            const group = current.find((candidate) => candidate.id === groupId);
            if (!group?.unread) return current;
            return current.map((candidate) =>
              candidate.id === groupId ? { ...candidate, unread: false } : candidate,
            );
          });
        })
        .catch(() => {
          readVisibleGroups.current.delete(groupId);
        });
    };
    markVisibleGroupRead();
    window.addEventListener("focus", markVisibleGroupRead);
    document.addEventListener("visibilitychange", markVisibleGroupRead);
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
      expandedHistoryThread.current = null;
    }
    historyEpoch.current += 1;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: () =>
        pendingJump
          ? rpc.threads.get({ groupId }, { signal: threadSnapshotSignal(abort.signal) })
          : refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      loadHead: () => rpc.threads.head({ groupId }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor, signal) => rpc.threads.subscribe({ groupId, cursor }, { signal }),
      applyEvent: (event) =>
        applyThreadEvent(
          event,
          commitSnapshot,
          (next) => {
            if (isComputerStatusEvent(event) && event.botId !== computerBotIdRef.current) return;
            commitComputer(next);
          },
          snapshotRef,
          computerRef,
        ),
      onEvent: (event, initial) => {
        const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          eventBot?.name ?? activeGroup.name,
          true,
          true,
        );
        if (event.type === "thread.message.created" && event.payload.role === "bot") {
          readVisibleGroups.current.delete(groupId);
          markVisibleGroupRead();
        }
        if (
          event.type === "run.started" ||
          event.type === "bot.updated" ||
          event.type === "group.updated" ||
          isRunTerminalEvent(event)
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void refreshGroupThread(groupId).catch(() => undefined);
        }
      },
    });
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [activeGroup?.id, groupId, notifyBrowserForEvent]);

  const sidebarSpaces = useMemo(
    () =>
      spaces.length > 0
        ? spaces
            .filter((space) => space.id === bootstrapMe?.spaceId)
            .map((space) => ({ ...space, bots, groups, botSections }))
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                bots,
                groups,
                botSections,
              },
            ]
          : [],
    [bootstrapMe, botSections, bots, groups, spaces],
  );
  const sidebarGroups = useMemo(
    () =>
      sidebarGroupsForSpaces(sidebarSpaces, miniSidebar ? "" : query, {
        pinned: t`Pinned`,
        unassigned: t`Unassigned`,
      }),
    [sidebarSpaces, query, miniSidebar, t],
  );
  const openSpaceChat = useCallback(
    (_spaceId: string, path: string) => {
      setMobileSidebarOpen(false);
      navigate(path);
    },
    [navigate],
  );
  const {
    draggedBotId,
    setDraggedBotId,
    rosterDropKey,
    setRosterDropKey,
    reorderRosterBot,
    rosterDropAction,
    applyRosterDrop,
  } = useRosterReorder({
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
  });
  const { searchHits, setSearchHits, searchLoading, showSpaceSearch } = useSpaceSearch(
    rpc,
    query,
    activityMode,
  );

  async function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchHits([]);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: hit.groupId ? `/app/g/${hit.groupId}` : `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  async function jumpToMessage(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = searchHitThreadTarget(target);
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      rpc.threads.get(threadTarget),
      rpc.threads.messages({ ...threadTarget, around: { messageId: target.messageId } }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    // jumpId drops an older jump that finished after a newer click.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    // A reply folded under its peer marker counts: the transcript expands the marker to show it.
    const pageTranscript = foldPeerReplies(page.messages, { includePeerReceipts: true });
    const targetInPage =
      pageTranscript.markerOf.has(target.messageId) ||
      pageTranscript.messages.some((message) => message.id === target.messageId);
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? {
          ...threadTarget,
          messageId: target.messageId,
          threadId: page.threadId,
          messages: page.messages,
          olderCursor: page.olderCursor,
        }
      : null;
    if (targetInPage) initiallyScrolledThread.current = page.threadId;
    commitSnapshot({
      ...snap,
      messages: targetInPage ? page.messages : snap.messages,
      olderCursor: targetInPage ? page.olderCursor : snap.olderCursor,
    });
    if (threadTarget.botId) {
      commitComputer(snap.computer ?? null);
      // Don't block parent-scroll on routines metadata; a list failure must not abort the jump.
      void rpc.routines
        .list({ botId: threadTarget.botId })
        .then((routines) => {
          if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
          if (activeBotId.current !== threadTarget.botId) return;
          setRoutines(routines);
          setRoutinesBotId(threadTarget.botId);
        })
        .catch(() => undefined);
    } else {
      commitComputer(null);
      setRoutines([]);
      setRoutinesBotId(null);
    }
    if (targetInPage) {
      // The transcript owns the scroll: it retries until the pinned row is
      // mounted and unfollows the tail, so live commits cannot cancel it.
      setScrollRequest({ messageId: target.messageId, nonce: jumpId });
    } else {
      window.requestAnimationFrame(() => {
        if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = page.threadId;
        }
      });
    }
  }

  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    resetRoutineTarget();
    setPanelState((current) => (current === "routine" ? null : current));
  }, [active?.id]);

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (inGroup && groupId && messageId) {
      void jumpToMessage({ groupId, messageId }).finally(() => {
        // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        editRoutine(routine);
        setPanel("routine");
      } else {
        setPanel("computer");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId) {
      void jumpToMessage({ botId: active.id, messageId }).finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
    }
  }, [active?.id, groupId, inGroup, routines, routinesBotId, searchParams, setSearchParams]);
  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyQuote(null);
  }, []);
  const currentRuns = activeThreadRuns(activeSnapshot);
  const answerableAskIds = useMemo(() => answerableAskMessageIds(activeSnapshot), [activeSnapshot]);
  const dismissableAskIds = useMemo(
    () => dismissableAskMessageIds(activeSnapshot, userId),
    [activeSnapshot, userId],
  );
  const workingRuns = currentRuns.filter((run) => isRunWorking(run.status));
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const transcript = useMemo(
    () => foldPeerReplies(activeSnapshot?.messages ?? [], { includePeerReceipts: true }),
    [activeSnapshot?.messages],
  );
  const transcriptRef = useRef(transcript);
  useLayoutEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      name: bot?.name,
      status: run.status,
    };
  });
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );
  const replyTargetName = activeReplyTarget
    ? activeReplyTarget.role === "user"
      ? t`You`
      : (resolveTranscriptMemberName(activeReplyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  const shellReady =
    initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));
  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;
  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;

  const { mentionRoutines, mentionConnectors, footerLogos, setFooterLogos } = useMentionSources(
    rpc,
    bots,
    initialBotsLoaded,
  );

  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: bots.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [bots, groupId, groups, inGroup, mentionConnectors, mentionRoutines],
  );

  useLayoutEffect(() => {
    if (initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, snapshot?.botId]);

  useLayoutEffect(() => {
    const pin = pinnedAroundRef.current;
    if (inGroup) {
      if (!groupId || !snapshot || snapshot.groupId !== groupId) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.groupId === groupId) return;
    } else {
      if (!active || !snapshot || snapshot.botId !== active.id) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.botId === active.id) return;
    }
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = snapshot.threadId;
  }, [active, groupId, inGroup, snapshot?.botId, snapshot?.groupId, snapshot?.threadId]);

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const jumpToReplyMessage = useCallback((messageId: string) => {
    const inTranscript =
      transcriptRef.current.markerOf.has(messageId) ||
      document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (inTranscript) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      setScrollRequest({ messageId, nonce: jumpGeneration.current });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId }).catch(() => undefined);
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId }).catch(() => undefined);
  }, []);
  const {
    answerMessage,
    reactToMessage,
    onAttachmentPick,
    removeAttachment,
    sendMessage,
    stopRun,
  } = useComposerActions({
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
  });
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Transcript and MessageView are memoized; these must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
  }, []);
  async function createGroup(input: { name: string; botIds: string[] }) {
    const group = await rpc.groups.create(input);
    setGroups((current) =>
      current.some((item) => item.id === group.id) ? current : [group, ...current],
    );
    navigate(`/app/g/${group.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
  }

  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  function openSettings(section: SettingsSection = "general") {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const isFirstBot = botsRef.current.length === 0;
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    // A roster requested before creation may omit this bot and redirect its new chat.
    botsRefreshEpoch.current += 1;
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = bot.id;
    const started = await rpc.onboarding
      .start({ botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== bot.id) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      await refreshBots().catch(() => undefined);
      return;
    }
    void scheduleFocusPrompt({
      immediate: isFirstBot,
      signal: controller.signal,
      shouldSkip: () => sendingRef.current,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== bot.id || activeBotId.current !== bot.id) return;
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
    await refreshBots().catch(() => undefined);
  }

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    showProgress,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    showProgress: boolean;
    force?: boolean;
  }) {
    const epoch = ++computerBootEpoch.current;
    const stillThisBoot = () => computerBootEpoch.current === epoch;
    const stillThisBot = () =>
      computerBotIdRef.current === targetBotId || activeBotId.current === targetBotId;
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    if (showProgress && needsBoot) setBootingBotId(targetBotId);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      if (needsBoot) {
        const status = await bootComputerOnce(bootsInFlight.current, targetBotId, () =>
          rpc.computer.boot({ botId: targetBotId }),
        );
        if (!stillThisBoot() || !stillThisBot()) return;
        if (status) {
          commitComputer(status);
          cacheComputerFor(targetBotId, { computer: status });
        }
      }
      if (takeControl) {
        await rpc.computer.takeover({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
      }
      await refreshComputerFor(targetBotId);
    } catch (error) {
      if (!stillThisBoot() || !stillThisBot()) return;
      setComputerError(errorText(error, t`Could not take control`));
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (stillThisBoot()) setBootingBotId(null);
    }
  }

  async function refreshComputerFor(targetBotId: string) {
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId);
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const status = await rpc.computer.status({ botId: targetBotId });
    if (computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    await refreshComputerScreen(targetBotId);
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    const botId = active.id;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first. A stale SSE "booting" snapshot used to
      // skip this effect, so an RPC takeover never showed "You have control".
      const snap = await refreshThread(botId).catch(() => null);
      if (cancelled || activeBotId.current !== botId) return;
      const state = snap?.computer?.state;
      const screen = state === "running" ? await refreshComputerScreen(botId) : null;
      if (cancelled || activeBotId.current !== botId) return;
      if (!computerPanelNeedsScreen(state, screen) || autoBooted.current === botId) return;
      autoBooted.current = botId;
      await bootComputer({
        botId,
        takeControl: false,
        showProgress: false,
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== active?.id) {
      cancelFocusPrompt();
    }
  }, [active?.id]);

  useEffect(() => () => cancelFocusPrompt(), []);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (panel !== "routine") {
      leaveRoutine();
    }
  }, [panel]);

  useEffect(() => {
    if (!panelStorageKey) return;
    if (observedPanelKey.current !== panelStorageKey) {
      observedPanelKey.current = panelStorageKey;
      if (pendingExplicitPanel.current || explicitPanelTarget.current === panelStorageKey) {
        pendingExplicitPanel.current = false;
        explicitPanelTarget.current = null;
        pendingPanelRestore.current = null;
        setRestoredPanelKey(panelStorageKey);
        return;
      }
      explicitPanelTarget.current = null;
      // Reload starts with panel=null so storage restores. In-session chat switches used to
      // keep computer/settings open; only routine was cleared (handled above). Carry is
      // session-only — do not write the carried panel onto the destination's saved prefs.
      if (panel === "computer" || panel === "settings" || panel === "group-settings") {
        const carried = panel === "computer" ? "computer" : inGroup ? "group-settings" : "settings";
        pendingPanelRestore.current = null;
        if (carried !== panel) setPanelState(carried);
        setRestoredPanelKey(null);
        return;
      }
      pendingPanelRestore.current = readRightPanelState(panelStorageKey);
    }
    const saved = pendingPanelRestore.current;
    if (!saved) return;
    // Explicit routine links take precedence over a local layout preference.
    if (searchParams.has("routine")) {
      pendingPanelRestore.current = null;
      return;
    }
    if (saved.panel === "routine" && saved.routineId && routinesBotId !== active?.id) return;
    let next = saved.panel;
    if (next === "routine") {
      const routine = saved.routineId
        ? routines.find((item) => item.id === saved.routineId)
        : undefined;
      if (saved.routineId && !routine) next = "computer";
      restoreRoutine(routine ?? null);
    }
    pendingPanelRestore.current = null;
    setPanelState(next);
    setRestoredPanelKey(panelStorageKey);
  }, [panelStorageKey, active?.id, inGroup, panel, routinesBotId, routines, searchParams]);

  useEffect(() => {
    // Do not gate writes on ?routine= staying in the URL — a stuck/failed routine
    // list would freeze layout prefs. Deep-link handling uses setPanelState for the
    // bot-switch close so restoredPanelKey stays unset until an intentional setPanel.
    if (!panelStorageKey || restoredPanelKey !== panelStorageKey || pendingPanelRestore.current)
      return;
    writeRightPanelState(panelStorageKey, panel, editingRoutine?.id);
  }, [panelStorageKey, restoredPanelKey, panel, editingRoutine?.id]);

  useEffect(() => {
    const threadKey = inGroup ? groupId : active?.id;
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [active?.id, clearReply, groupId, inGroup]);

  useShellHotkeys(computerOpen, setComputerOpen, setCommandPaletteOpen);

  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if ((panel !== "computer" && !computerOpen) || !heartbeatBotId || computer?.state !== "running")
      return;
    // A computer panel left open in a hidden window must not keep the computer awake.
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void rpc.computer.heartbeat({ botId: heartbeatBotId }).catch((error) => {
        if (!isRetryableError(error)) window.clearInterval(timer);
      });
    };
    const timer = window.setInterval(ping, 60_000);
    ping();
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, computerBot?.id, active?.id, computer?.state]);

  /** Open the computer view. Only an explicit Take control asks for the lease. */
  async function openComputer(botId?: string, takeControl = false) {
    const id = botId ?? active?.id;
    if (!id) return false;
    const bot = botsRef.current.find((candidate) => candidate.id === id);
    if (!bot) return false;
    computerBotIdRef.current = id;
    setComputerBotId(id);
    const cached = computerCacheRef.current.get(id);
    const targetComputer = computer?.botId === id ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === id ? screenUrl : (cached?.screenUrl ?? null);
    if (computer?.botId !== id) {
      commitComputer(targetComputer);
      setScreenUrl(targetScreen);
    }
    // Reopening during a boot shows it; a second boot would be refused as busy.
    const bootInFlight = bootsInFlight.current.has(id) || targetComputer?.state === "booting";
    setComputerOpen(true);
    computerVisible.current = true;
    if (bootInFlight && !takeControl) return true;
    const needsTakeover = takeControl && !userHoldsComputerControl(targetComputer, id);
    const blocked = computerTakeoverBlocked(targetComputer, snapshot?.run?.status);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover && !blocked,
        showProgress: (needsTakeover && !blocked) || targetComputer?.state !== "running",
        force: targetComputer?.state !== "running",
      });
      return true;
    } catch {
      // computerError already set in bootComputer
      return false;
    }
  }
  openComputerRef.current = openComputer;
  const onOpenComputer = useCallback((botId?: string) => {
    void openComputerRef.current(botId);
  }, []);

  async function releaseComputer(reason?: ComputerReleaseReason) {
    const botId = computerBotIdRef.current ?? activeBotId.current;
    if (!botId) return;
    try {
      await rpc.computer.release({ botId, reason });
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      await refreshComputerFor(botId).catch(() => undefined);
      const groupId = activeGroupId.current;
      if (groupId) {
        await refreshGroupThreadRef.current(groupId).catch(() => undefined);
      }
    } catch {
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      setComputerError(t`Could not continue`);
      setComputerErrorFromScreen(false);
    }
  }

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const computerFailure =
    computerError && !hideScreenLoadError
      ? computerError
      : screenLoadError
        ? screenLoadError
        : !booting && computer?.state === "error"
          ? t`Computer failed to boot`
          : null;
  const computerScreenError = computerFailure ? (
    <ComputerScreenError
      message={computerFailure}
      onRetry={() => {
        if (!computerBot) return;
        setScreenLoadError(null);
        if (computer?.state === "running") {
          // An explicit retry clears any error; background screen reads clear only their own.
          setComputerError(null);
          setComputerErrorFromScreen(false);
          void refreshComputerScreen(computerBot.id);
        } else
          void bootComputer({
            botId: computerBot.id,
            takeControl: false,
            showProgress: true,
            force: true,
          }).catch(() => undefined);
      }}
    />
  ) : null;
  // Booting shows inline with the screen's own Close; leaving it lets the boot finish.
  const computerBooting =
    booting || computer?.state === "booting" ? <ComputerBootingStatus /> : null;
  const computerPreviewScreen =
    !computerOpen &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  const showingRecoveryHint =
    !computerOpen && !computerPreviewScreen && !computerScreenError && showComputerRecoveryHint;

  const { label: userName, initial: initials } = accountDisplay(session.data?.user ?? {}, t`You`);

  const botMenuContent = (
    <BotContextMenuContent
      rpc={rpc}
      contextBot={contextBot}
      contextGroup={contextGroup}
      botSections={botSections}
      userId={userId}
      spaceId={bootstrapMe?.spaceId}
      onClose={closeBotMenu}
      refreshBots={refreshBots}
      markBotRead={markBotRead}
      markBotUnread={markBotUnread}
      setGroups={setGroups}
      setNewSectionTarget={setNewSectionTarget}
      setRenameSectionTarget={setRenameSectionTarget}
      setDeleteTarget={setDeleteTarget}
      setDeleteGroupTarget={setDeleteGroupTarget}
      setClearTarget={setClearTarget}
      beginExplicitPanel={(destKey) => {
        explicitPanelTarget.current = destKey;
        pendingPanelRestore.current = null;
      }}
      showPanel={(next, destKey) => {
        setPanelState(next);
        setRestoredPanelKey(destKey);
      }}
      navigate={navigate}
    />
  );

  async function confirmClear(target: ChatTarget) {
    await rpc.threads.clear(
      target.kind === "bot" ? { botId: target.chat.id } : { groupId: target.chat.id },
    );
    if (
      (target.kind === "bot" && active?.id === target.chat.id) ||
      (target.kind === "group" && activeGroup?.id === target.chat.id)
    ) {
      expandedHistoryThread.current = null;
      pinnedAroundRef.current = null;
      historyEpoch.current += 1;
      updateSnapshot((current) =>
        current ? { ...current, messages: [], olderCursor: null, run: null } : current,
      );
    }
    setClearTarget(null);
    await refreshBots();
  }

  const shell = (
    <BotsSidebarLayout
      userId={userId}
      collapsed={botsSidebarCollapsed}
      onCollapsedChange={setBotsSidebarCollapsedPref}
      computerOpen={computerOpen}
      data-testid="shell-root"
      data-ready={shellReady}
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground/90 [&[data-resizing-sidebar]_*[data-slot=sidebar-gap]]:transition-none [&[data-resizing-sidebar]_*[data-slot=sidebar-container]]:transition-none"
      {...swipeHandlers}
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      <ShellSidebar
        rpc={rpc}
        isMobileSidebar={isMobileSidebar}
        mobileSidebarOpen={mobileSidebarOpen}
        setMobileSidebarOpen={setMobileSidebarOpen}
        botsSidebarDensity={botsSidebarDensity}
        botsSidebarCollapsed={botsSidebarCollapsed}
        miniSidebar={miniSidebar}
        setBotsSidebarCollapsedPref={setBotsSidebarCollapsedPref}
        activityMode={activityMode}
        toggleActivityMode={toggleActivityMode}
        activityFilters={activityFilters}
        setActivityFilters={setActivityFilters}
        activityFiltersExpanded={activityFiltersExpanded}
        setActivityFiltersExpanded={setActivityFiltersExpanded}
        activityFiltersId={activityFiltersId}
        activityFilterCount={activityFilterCount}
        query={query}
        setQuery={setQuery}
        bots={bots}
        setPanel={setPanel}
        navigate={navigate}
        setPickerInfoTopic={setPickerInfoTopic}
        showSpaceSearch={showSpaceSearch}
        searchHits={searchHits}
        searchLoading={searchLoading}
        jumpToSearchHit={jumpToSearchHit}
        archivedBots={archivedBots}
        archivedGroups={archivedGroups}
        refreshBots={refreshBots}
        setDeleteTarget={setDeleteTarget}
        setDeleteGroupTarget={setDeleteGroupTarget}
        footerLogos={footerLogos}
        userName={userName}
        initials={initials}
        userImage={session.data?.user.image}
        userEmail={session.data?.user.email}
        ticketBoardEnabled={bootstrapMe?.ticketBoardEnabled}
        setPluginsOpen={setPluginsOpen}
        openSettings={openSettings}
        spaces={spaces}
        currentSpaceId={bootstrapMe?.spaceId}
        sidebarGroups={sidebarGroups}
        collapsedSidebarSections={collapsedSidebarSections}
        collapsedRosterParents={collapsedRosterParents}
        bootstrapMe={bootstrapMe}
        botSections={botSections}
        rosterDropKey={rosterDropKey}
        setRosterDropKey={setRosterDropKey}
        rosterDropAction={rosterDropAction}
        applyRosterDrop={applyRosterDrop}
        openSpaceChat={openSpaceChat}
        setRenameSectionTarget={setRenameSectionTarget}
        setDeleteSectionTarget={setDeleteSectionTarget}
        toggleSidebarSection={toggleSidebarSection}
        inGroup={inGroup}
        active={active}
        activeGroup={activeGroup}
        dismissedRunErrorIds={dismissedRunErrorIds}
        displayedRunError={displayedRunError}
        draggedBotId={draggedBotId}
        setDraggedBotId={setDraggedBotId}
        toggleRosterParent={toggleRosterParent}
        botMenu={botMenu}
        setBotMenu={setBotMenu}
        reorderRosterBot={reorderRosterBot}
        activeSnapshot={activeSnapshot}
        botMenuContent={botMenuContent}
      />

      {/* Keep the composer's z-index inside the chat so phone overlays like the side panel cover it. */}
      <main
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen}
        className="isolate flex min-w-0 flex-1 flex-col bg-background"
      >
        {/* Inside main so the composer and its menus stay above it. */}
        {!mobileSidebarOpen ? (
          <div
            data-testid="mobile-sidebar-swipe-edge"
            aria-hidden="true"
            className="absolute bottom-20 start-0 top-16 z-20 w-8 touch-none md:hidden"
          />
        ) : null}
        <ShellMainHeader
          inGroup={inGroup}
          active={active}
          activeGroup={activeGroup}
          activeSnapshot={activeSnapshot}
          panel={panel}
          setPanel={setPanel}
          setMobileSidebarOpen={setMobileSidebarOpen}
          refreshThread={refreshThread}
        />
        {!active && !activeGroup && initialBotsLoaded ? (
          <div className="grid flex-1 place-items-center">
            <Button onClick={() => setPanel("create")}>
              <Plus size={16} aria-hidden="true" />
              <Trans>Create new Bot</Trans>
            </Button>
          </div>
        ) : (
          <Transcript
            key={activeSnapshot?.threadId}
            scrollRef={messageScroll}
            scrollRequest={scrollRequest}
            onScrollRequestHandled={clearScrollRequest}
            artifactTarget={transcriptArtifactTarget}
            transcript={transcript}
            showToolActivity={showToolActivity}
            olderCursor={activeSnapshot?.olderCursor ?? null}
            loadingOlder={loadingOlder}
            answerableAskIds={answerableAskIds}
            dismissableAskIds={dismissableAskIds}
            running={transcriptRunning}
            workingBots={workingBots}
            onLoadOlder={loadOlder}
            onOpenBot={openBot}
            onAnswer={answerMessage}
            onReply={(message) => {
              setReplyTarget(message);
              setReplyQuote(null);
            }}
            onQuote={(message, quote) => {
              setReplyTarget(message);
              setReplyQuote(quote);
            }}
            onReact={reactToMessage}
            onJumpToMessage={jumpToReplyMessage}
            onOpenPeerMessages={(peer) => {
              setPeerConversation(peer);
            }}
            memberName={resolveTranscriptMemberName}
            peerBot={resolveTranscriptBot}
            onRefresh={refreshActiveThread}
            onBotChanged={refreshBots}
            onAddRoutine={addSkillRoutine}
            onOpenComputer={onOpenComputer}
          />
        )}
        {recordingSkill ? (
          <div className="px-6 pb-2 text-center text-[13px] text-destructive">
            <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
          </div>
        ) : null}
        {active || activeGroup ? (
          <Composer
            key={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
            draftKey={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
            enterToSend={enterToSend}
            activeName={inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name}
            running={composerRunning}
            disabled={Boolean(recordingSkill)}
            pendingAttachments={activePendingAttachments}
            attachmentNotice={attachmentNotice}
            sendError={sendError}
            onOpenModels={() => openSettings("models")}
            runError={displayedRunError}
            runErrorId={displayedRunErrorId}
            onRunErrorPresented={handleRunErrorPresented}
            onDismissError={dismissComposerError}
            sending={sending}
            fileInputRef={fileInputRef}
            onAttachmentPick={onAttachmentPick}
            onRemoveAttachment={removeAttachment}
            onSend={sendMessage}
            onStop={stopRun}
            artifactTarget={transcriptArtifactTarget}
            replyTarget={activeReplyTarget}
            replyQuote={activeReplyQuote}
            replyTargetName={replyTargetName}
            onClearReply={clearReply}
            mentionTargets={composerMentionTargets}
            agentSkills={agentSkills}
            onSlashOpen={refreshAgentSkills}
            onSlashAction={(action) => {
              if (action === "chat-settings") {
                setPanel(inGroup ? "group-settings" : "settings");
                return;
              }
              if (action === "settings-general") {
                openSettings("general");
                return;
              }
              if (action === "settings-usage") {
                openSettings("usage");
              }
            }}
          />
        ) : null}
      </main>

      <ShellSidePanel
        rpc={rpc}
        panel={panel}
        setPanel={setPanel}
        active={active}
        activeGroup={activeGroup}
        bots={bots}
        setBots={setBots}
        groups={groups}
        setGroups={setGroups}
        snapshot={snapshot}
        computer={computer}
        computerOpen={computerOpen}
        booting={booting}
        embeddedScreenUrl={embeddedScreenUrl}
        setScreenFrame={setScreenFrame}
        computerScreenError={computerScreenError}
        computerBooting={computerBooting}
        showingRecoveryHint={showingRecoveryHint}
        showComputerRecoveryHint={showComputerRecoveryHint}
        bootstrapMe={bootstrapMe}
        setBootstrapMe={setBootstrapMe}
        holdComputerRecovery={holdComputerRecovery}
        releaseComputerRecovery={releaseComputerRecovery}
        openSettings={openSettings}
        openComputer={openComputer}
        activeRoutines={activeRoutines}
        startRoutine={startRoutine}
        stopRun={stopRun}
        routineEditorProps={routineEditorProps}
        refreshThread={refreshThread}
        refreshGroupThread={refreshGroupThread}
        refreshBots={refreshBots}
        createGroup={createGroup}
        createBot={createBot}
        openBot={openBot}
        navigate={navigate}
        setAgentSkills={setAgentSkills}
        setClearTarget={setClearTarget}
      />

      <ShellDialogs
        rpc={rpc}
        setPanel={setPanel}
        refreshBots={refreshBots}
        deleteTarget={deleteTarget}
        setDeleteTarget={setDeleteTarget}
        deleteGroupTarget={deleteGroupTarget}
        setDeleteGroupTarget={setDeleteGroupTarget}
        newSectionTarget={newSectionTarget}
        setNewSectionTarget={setNewSectionTarget}
        renameSectionTarget={renameSectionTarget}
        setRenameSectionTarget={setRenameSectionTarget}
        deleteSectionTarget={deleteSectionTarget}
        setDeleteSectionTarget={setDeleteSectionTarget}
        commandPaletteOpen={commandPaletteOpen}
        setCommandPaletteOpen={setCommandPaletteOpen}
        bots={bots}
        onSelectBot={(id) => {
          setMobileSidebarOpen(false);
          navigate(`/app/${id}`);
        }}
        pickerInfoTopic={pickerInfoTopic}
        setPickerInfoTopic={setPickerInfoTopic}
        clearTarget={clearTarget}
        setClearTarget={setClearTarget}
        confirmClear={confirmClear}
        deleteRoutineDialogProps={deleteRoutineDialogProps}
        pluginsOpen={pluginsOpen}
        setPluginsOpen={setPluginsOpen}
        setFooterLogos={setFooterLogos}
        activeBotId={activeBotId.current}
        mcpOpen={mcpOpen}
        setMcpOpen={setMcpOpen}
        messagingSettingsOpen={messagingSettingsOpen}
        setMessagingSettingsOpen={setMessagingSettingsOpen}
      />

      <ShellSettingsOverlays
        rpc={rpc}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        settingsSection={settingsSection}
        setSettingsSection={setSettingsSection}
        setMessagingSettingsOpen={setMessagingSettingsOpen}
        space={settingsSpace}
        userName={userName}
        userEmail={session.data?.user.email}
        usage={usage}
        refreshUsage={refreshUsage}
        bootstrapMe={bootstrapMe}
        setBootstrapMe={setBootstrapMe}
        messagingSurfaceEnabled={messagingSurfaceEnabled}
        peerConversation={peerConversation}
        setPeerConversation={setPeerConversation}
        active={active}
        resolveTranscriptBot={resolveTranscriptBot}
      />

      {computerOpen && computerBot ? (
        <ComputerOverlay
          bot={computerBot}
          computer={computer}
          computerViewport={computerViewport}
          recordingSkill={recordingSkill}
          teachBusy={teachBusy}
          hasControl={hasControl}
          composerRunning={composerRunning}
          sending={sending}
          booting={booting}
          runStatus={snapshot?.run?.status}
          sendError={sendError}
          embeddedScreenUrl={embeddedScreenUrl}
          screenFrameRef={setScreenFrame}
          computerScreenError={computerScreenError}
          computerBooting={computerBooting}
          onStopTeaching={stopTeaching}
          onStopRun={() => void stopRun()}
          onRelease={releaseComputer}
          onTakeControl={() => void openComputer(computerBot.id, true)}
          onRefreshTeaching={refreshActiveTeaching}
          onRefreshComputer={async () => {
            await refreshComputerFor(computerBot.id);
          }}
          onClose={() => setComputerOpen(false)}
        />
      ) : null}
    </BotsSidebarLayout>
  );

  return (
    <AvatarStyleProvider value={bootstrapMe?.avatarStyle ?? "organic"}>{shell}</AvatarStyleProvider>
  );
}
