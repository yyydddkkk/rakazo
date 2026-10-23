import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentToolExecutionObserver,
  AutoReviewRequest,
  ComputerRef,
  ConnectorCall,
  ConnectorTool,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  DEFAULT_CONTEXT_STRATEGY,
  historyCompactJob,
  MEMORY_REVISION_CONFLICT_ERROR,
  routineJobKey,
  routineWakeupJob,
  runContinueJob,
  SandboxRateLimitError,
} from "@rakazo/adapter-kit";
import type { ComputerCommand, MessageBlock, RunStatus } from "@rakazo/contracts";
import {
  ATTACHMENT_MAX_BYTES,
  BotSecretName,
  botSecretSubmissionSchema,
  COMPUTER_COMMAND_OUTPUT_MAX_CHARS,
  disabledBuiltinToolSet,
  HistoryReadInputSchema,
  HistorySearchInputSchema,
  isAttachmentImageMimeType,
} from "@rakazo/contracts";
import type { ActionApprovalRule, ToolCallStreak } from "@rakazo/core";
import {
  appendTextSegment,
  appendToolCallSegment,
  applyJudgeDecision,
  assertTransition,
  botMessageAllowsSilence,
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  connectorToolRequiresApproval,
  containsSecret,
  createStreamingRedactor,
  displayName,
  endsSentence,
  expandSkillReferencesInPrompt,
  formatSkillRunPrompt,
  formatSkillsCatalogInstruction,
  humanizeToolName,
  inboundRoutinePrompts,
  inferAttachmentMimeType,
  isBackgroundRunTrigger,
  isMessagingChannelRun,
  isOneShotRoutineCrons,
  isOwnerStartedRun,
  isTerminal,
  messagingChannelId,
  messagingChannelPrivacyBlock,
  messagingDmSurfaceNote,
  newSiteOutcome,
  nextCronDateAcross,
  nextFence,
  outboundSiteGate,
  planActionGate,
  promptInvokesSkill,
  redactSecrets,
  renderBotDirectory,
  resolveActionApprovalDetail,
  sandboxCommandTimeoutMs,
  siteAlwaysAllowed,
  TAKEOVER_COMPUTER_PENDING_STATE,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  toolResultTaintsRun,
  unattendedTriggerToolRequiresApproval,
  userTurnMessageForRun,
} from "@rakazo/core";
import { normalizedHttpUrl, sitesInText, urlSite } from "@rakazo/core/egress";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { McpServer } from "@rakazo/db";
import {
  findDefaultModelCredential,
  InstructionConflictError,
  isTooManyDatabaseConnections,
  loadRunHistoryMessages,
  Prisma,
  parseComputerMode,
  RunHistoryWriteError,
  readHistory,
  recordUsage,
  reserveInstructionProposal,
  searchHistory,
  settleReleasedTakeoverCards,
  validateInstructionProposal,
  writeBotInstructions,
} from "@rakazo/db";
import { enrichLogContext, getLogger } from "@rakazo/logging";
import {
  connectAgent,
  messageConnectedAgent,
  respondAgentConnection,
} from "./agent-connections.js";
import {
  decryptAgentEnvironment,
  formatAgentEnvironmentInstruction,
  redactShellStreams,
} from "./agent-environment.js";
import type { FleetCardSummary } from "./approval-ask.js";
import { buildApprovalAskBlock, MAX_FETCH_URL_LENGTH } from "./approval-ask.js";
import {
  approvalPausedToolResult,
  approvalReplayPathError,
  approvalReplayResourceError,
  approvalRoutesMatch,
  approvedCatalogReplay,
  approvedReplayArgs,
  boundDirectApprovalDetails,
  boundDirectApprovalRequest,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
  catalogApprovalMatchesLiveRoute,
  catalogApprovalRequest,
  claimApprovedEffect,
  claimIntendedEffect,
  completeExternalEffect,
  createApprovedEffectReplayQueue,
  isToolPauseResult,
  replaceCompletedExternalEffectResult,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
  uncertainEffectResult,
} from "./approval-effect.js";
import {
  autoReviewTimeoutMs,
  deploymentAutoReviewDefault,
  isAutoReviewCheckerConfigured,
  redactToolArgsForReview,
  resolveAutoReviewChecker,
  resolveAutoReviewProviderKind,
} from "./auto-review.js";
import { createAutoReviewProvider } from "./auto-review-factory.js";
import { attachedImageArtifactIds, resolveUpdateBotAvatar } from "./bot-avatar.js";
import { loadBotMessageContext, messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import {
  allowPrivateHttpSecretOrigins,
  botSecretToolView,
  commandCredentialRedactions,
  findBotSecret,
  findCommandVariableConflict,
  forgetBotSecret,
  listBotSecrets,
  loadBotCommandEnvironment,
  normalizeSecretDestination,
  requestWithBotSecret,
  resolveLoginFill,
  resolveRequestSecretDestination,
  sameSecretDestination,
  shellCommandEnvironment,
} from "./bot-secrets.js";
import { createBrowserProvider } from "./browser-provider-factory.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
} from "./browser-tools.js";
import { agentConnectionTools, builtinAgentTools, sharedMemorySaveError } from "./builtin-tools.js";
import { archiveSpawnedBot, spawnBot } from "./child-bots.js";
import { cloudAgentsEnabled } from "./cloud-agent-factory.js";
import { executeCloudAgentTool } from "./cloud-agent-service.js";
import { validCloudAgentArgs } from "./cloud-agent-tools.js";
import { mergeConnectedPlugins, needsLivePluginSync } from "./composio-connector.js";
import { BACKGROUND_WORK_LAUNCH, scheduleComputerSleep } from "./computer-idle.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  holdComputerExecutionLeaseForTakeover,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import {
  displayBotWorkspacePath,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";
import type { UnchangedVisualStreak } from "./computer-tools.js";
import {
  advanceUnchangedVisualGuard,
  computerVisualActionKey,
  observationToolResult,
  parseComputerActions,
  unchangedVisualActionBlocked,
  unchangedVisualLoopToolResult,
  unchangedVisualStreakAfterPageBrowser,
} from "./computer-tools.js";
import { checkpointRunComputerWorkspace } from "./computer-workspace.js";
import { connectApp } from "./connect-app.js";
import { connectedContext, selectRunConnections } from "./connection-context.js";
import {
  collectLogIds,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { formatCurrentTimeInstruction } from "./current-time.js";
import { resolveDeploymentModel } from "./deployment-model.js";
import {
  APPROVED_EFFECT_REPLAY_ORDER,
  approvalReplayEffectToolName,
  buildApprovalContinuation,
  CATALOG_APPROVAL_TOOL,
} from "./executor/approval-continuation.js";
import type { ExecutorDeps } from "./executor/deps.js";
import {
  BOT_DIRECTORY_LIMIT,
  desktopProtectionGuardMessage,
  MISSING_MODEL_MESSAGE,
  protectedActivateScriptWriteRefusal,
  protectedComputerLifecycleRefusal,
  runtimeFallbackModel,
} from "./executor/desktop-guard.js";
import {
  completeEffect,
  isSubagentToolExecution,
  recordEffect,
  runScopedToolExecutionId,
  uncertainEffectError,
} from "./executor/effects.js";
import { loadLivePluginSlugs, persistLivePluginConnections } from "./executor/live-connections.js";
import {
  isUniqueViolation,
  persistMessageInTransaction,
  publishMessage,
  redactBlocks,
} from "./executor/messages.js";
import { resolveModelKey } from "./executor/model-key.js";
import {
  builtinOffered,
  completionMarksUnread,
  completionMessageSegments,
  completionNotificationBody,
  completionNotificationPreview,
  DELEGATED_EMPTY_NOTICE,
  dockerComputerToolInstruction,
  emptyDelegatedToolTurnShouldFail,
  mayOpenModelStream,
  missingTurnImagesInstruction,
  offeredFleetTools,
  persistentComputerInstruction,
  runAllowsSilentEmpty,
  runIdentityInstruction,
  runPromotesMidTurnNarration,
  runReplyGuidance,
  runSendsFinishNotification,
  settleSteeringAttachmentLoads,
  subagentMarksUnread,
  TOOL_STEPS_WITHOUT_RESPONSE,
  threadContextForRun,
  userTurnInstructions,
} from "./executor/run-instructions.js";
import {
  computerRetryDelay,
  computerScreenToolResult,
  deferFutureRoutine,
  failRunBeforeTurn,
  notifyFailedRoutineRun,
  notifyRun,
  RUN_SETUP_FAILURE_LIMIT,
  renewRunLease,
  requeueComputerRun,
  routineNextRunIsNear,
  scheduleRoutineRetry,
  setupFailureStreak,
  writeComputerRunRequeue,
} from "./executor/run-lifecycle.js";
import { appendToolCompletionAudit, toolCompletionFromResult } from "./executor/tool-completion.js";
import {
  FLEET_WRITE_TOOL_NAMES_SET,
  fleetPrepareDeps,
  PAGE_BROWSER_TOOL_NAMES,
  selectBuiltinToolsForRun,
} from "./executor/tool-selection.js";
import {
  loadCurrentTurnImages,
  RECENT_TURN_IMAGE_TURNS,
  withRecentTurnImages,
} from "./executor/turn-images.js";
import type { FleetRun } from "./fleet-tools.js";
import {
  createChildRoutine,
  createFleetGroup,
  isFleetApprovalTool,
  listFleet,
  organizeBot,
  prepareFleetRequest,
  setChildBotModel,
  setChildInstructions,
  updateChildBot,
  updateFleetGroup,
} from "./fleet-tools.js";
import { handoffToGroupBot, loadGroupContext } from "./group-handoff.js";
import {
  COMPACTION_BATCH_SIZE,
  formatCompactedSummary,
  HISTORY_WINDOW_SIZE,
  historyWindowSize,
  LEGACY_HISTORY_WINDOW_SIZE,
  selectCompactedHistory,
  shouldEnqueueCompaction,
} from "./history-compaction.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "./lazy-tool-catalog.js";
import {
  buildMcpCredentialBlob,
  needsOAuthProbe,
  parseMcpServerToolArgs,
} from "./mcp-server-tool.js";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import { generateMediaFromTool } from "./media-generation-tools.js";
import { loadAgentMemoryContext } from "./memory-context.js";
import { appendMemoryFact } from "./memory-tools.js";
import {
  findConnectedModelCredential,
  pinnedModelCredentialError,
  routineRunModelPin,
  runModelChoice,
  selectConfiguredModel,
  UnavailableModelForAuthError,
  validateConnectedModelChoice,
} from "./model-selection.js";
import {
  IMAGE_RETURNING_COMPUTER_TOOLS,
  MODEL_CANNOT_SEE_MESSAGE,
  modelAcceptsImageInput,
} from "./model-vision.js";
import { selectOmpHostTools } from "./omp-runtime.js";
import { ompWorkspaceDirectory } from "./omp-transport.js";
import { materializeOmpAttachments, readOmpAttachment } from "./omp-workspace.js";
import { isRetiredModelCredentialError } from "./pi-oauth.js";
import type { PlotSpec } from "./plot-tool.js";
import {
  assertPlotDataWithinLimits,
  PLOT_TOOL_GUIDE,
  parsePlotData,
  plotSvgToPng,
  renderPlotSpecToSvg,
  searchChartCatalog,
} from "./plot-tool.js";
import { actorMayUsePrivateEndpoint } from "./private-endpoint.js";
import { assertSafeRemoteUrl } from "./remote-mcp.js";
import { loadReplyContext, messageToAgentHistoryText } from "./reply-context.js";
import { routineTaskInstructions, tickRoutineWatch } from "./routine-watch.js";
import { lazyRunComputer } from "./run-computer.js";
import {
  commitConsumedRunSecret,
  normalizeSecretAskPurpose,
  reconcileManagedConnection,
  resolveCompletedSecretLeftover,
  resolveMissingRunSecretAction,
  runSecretKind,
  secretPausedToolResult,
  tryCompleteConnectionWithCode,
} from "./run-secret.js";
import { withRuntimeCleanup } from "./runtime-stream.js";
import {
  cancelScheduleFromTool,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  listSchedulesFromTool,
} from "./schedule-tools.js";
import { loadAgentScratchpadContext } from "./scratchpad-context.js";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "./scratchpad-tools.js";
import { inferScript } from "./scripted-runtime.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";
import { isExactNoResponse, stripNoResponseReply, stripStrayNoResponse } from "./silent-reply.js";
import {
  listAgentSkillRecords,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "./skill-tools.js";
import {
  continueRunClaimFence,
  DESKTOP_HELD_FOR_TAKEOVER_MESSAGE,
  refreshTakeoverContinuePlan,
  takeoverCheckpointOf,
  takeoverContinuePlan,
} from "./takeover-resume.js";
import { TASK_CATALOG_GUIDANCE, taskCatalogFromTool } from "./task-catalog.js";
import { getActiveTeachingSession, parsePlaybook } from "./teaching-session.js";
import {
  attachWorkspaceFileToThread,
  currentTurnFilesInstruction,
  listCurrentTurnFiles,
  listRecentThreadFiles,
  materializeCurrentTurnFiles,
  materializeRecentThreadFiles,
  recentThreadFilesInstruction,
} from "./thread-artifacts.js";
import { loadAgentTicketContext } from "./ticket-context.js";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
} from "./ticket-tools.js";
import { advanceToolCallLoopGuard, loopGuardStopText } from "./tool-loop.js";
import { textContentArg } from "./tool-text.js";
import { argumentGiven, parseUpdateBotPatch } from "./update-bot-patch.js";
import {
  assistantTurnSeparator,
  botMessageOutcomeFromMidTurn,
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  isProgressMessageTruncated,
  isUserProgressClientNonce,
  messageUserMaxLength,
  midTurnProgressBudgetAllows,
  userProgressClientNonce,
} from "./user-progress.js";
import { createWebProvider } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

export { selectRunConnections } from "./connection-context.js";
export {
  APPROVED_EFFECT_REPLAY_ORDER,
  approvalReplayEffectToolName,
  buildApprovalContinuation,
} from "./executor/approval-continuation.js";
export type { ExecutorDeps } from "./executor/deps.js";
export {
  desktopProtectionGuardMessage,
  isProtectedComputerLifecycleCommand,
  protectedActivateScriptWriteRefusal,
  protectedComputerLifecycleRefusal,
} from "./executor/desktop-guard.js";
export {
  isSubagentToolExecution,
  legacyPiToolCallId,
  recordEffect,
  runScopedToolExecutionId,
} from "./executor/effects.js";
export {
  completionMarksUnread,
  completionMessageSegments,
  completionNotificationBody,
  completionNotificationPreview,
  DELEGATED_EMPTY_NOTICE,
  dockerComputerToolInstruction,
  emptyDelegatedToolTurnShouldFail,
  isExactNoResponse,
  longWorkProgressGuidance,
  mayOpenModelStream,
  missingTurnImagesInstruction,
  NO_RESPONSE,
  offeredFleetTools,
  persistentComputerInstruction,
  REACTION_SILENT_REPLY_GUIDANCE,
  ROUTINE_SILENT_REPLY_GUIDANCE,
  runAllowsSilentEmpty,
  runIdentityInstruction,
  runPromotesMidTurnNarration,
  runReplyGuidance,
  runSendsFinishNotification,
  settleSteeringAttachmentLoads,
  stripNoResponseReply,
  stripStrayNoResponse,
  subagentMarksUnread,
  TICKET_SILENT_REPLY_GUIDANCE,
  TOOL_STEPS_WITHOUT_RESPONSE,
  threadContextForRun,
  userTurnInstructions,
} from "./executor/run-instructions.js";
export { deferFutureRoutine, runNotificationsEnabled } from "./executor/run-lifecycle.js";
export {
  appendToolCompletionAudit,
  toolCompletionAuditPayload,
  toolCompletionFromResult,
} from "./executor/tool-completion.js";
export {
  filterPageBrowserTools,
  PAGE_BROWSER_TOOL_NAMES,
  selectBuiltinToolsForRun,
} from "./executor/tool-selection.js";
export {
  loadCurrentTurnImages,
  RECENT_TURN_IMAGE_BYTES,
  RECENT_TURN_IMAGE_TURNS,
  withRecentTurnImages,
} from "./executor/turn-images.js";
export { persistLivePluginConnections };

/**
 * The connection a connector call reaches, for read trust. Installed APIs are told apart by their
 * resource, since their tool names share a prefix; other connectors by their tool-name kind.
 */
function connectorTrustKey(
  route: { connectorId?: string; resourceId?: string } | undefined,
  connectorKind: string,
): string {
  return route?.connectorId && route.resourceId
    ? `resource:${route.connectorId}:${route.resourceId}`
    : `kind:${connectorKind}`;
}

/** Effects that got past the approval gate: approved, allowed by a rule or review, or run. */
const PASSED_EFFECT_STATUSES = ["approved", "executing", "uncertain", "completed"];
const READ_ONLY_AGENT_TOOLS = new Set([
  "computer_observe",
  "list_files",
  "list_fleet",
  "read_file",
  "read_history",
  "search_history",
  "request_takeover",
  "run_subagent",
  "task_catalog",
  "schedule_list",
  "scratchpad_list",
  "board_tickets",
  "ticket_get",
  "skill_read",
  "web_search",
  "web_fetch",
  "browser_snapshot",
  "list_secrets",
  "cloud_agent_status",
]);
const MAX_MODEL_FILE_BYTES = 250_000;
const BUILTIN_AGENT_TOOL_NAMES = new Set(builtinAgentTools.map((tool) => tool.name));

/** Avoid an expensive remote workspace export when a turn never touched the computer. */
export function createRunWorkspaceCheckpoint(checkpoint: () => Promise<unknown>) {
  let dirty = false;
  return {
    markDirty() {
      dirty = true;
    },
    markFiles(files: readonly unknown[]) {
      if (files.length > 0) dirty = true;
    },
    async flush() {
      if (!dirty) return false;
      dirty = false;
      try {
        await checkpoint();
        return true;
      } catch (error) {
        dirty = true;
        throw error;
      }
    },
  };
}

export function isTerminalModelSetupError(error: unknown): boolean {
  return error instanceof UnavailableModelForAuthError || isRetiredModelCredentialError(error);
}

export function createRunExecutor(deps: ExecutorDeps) {
  const contextStrategy = deps.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY;
  const web = deps.web ?? createWebProvider();
  const mediaGeneration = deps.mediaGeneration ?? createMediaGenerationProvider();
  const browser = deps.browser ?? createBrowserProvider(undefined, { sandbox: deps.sandbox });
  const cloudAgent = deps.cloudAgent;
  const resolveConnectedModel = async (
    scope: { userId: string; spaceId: string },
    provider: string,
    modelId: string,
    registerSecrets?: (values: string[]) => void,
    requireStoredSecret = false,
  ): Promise<AgentRunRequest["model"]> => {
    const validationError = await validateConnectedModelChoice(
      deps.prisma,
      deps.secretStore,
      scope,
      provider,
      modelId,
    );
    if (validationError) throw new Error(validationError);
    const credential = await findConnectedModelCredential(
      deps.prisma,
      deps.secretStore,
      scope,
      provider,
      modelId,
    );
    if (!credential) throw new Error("Connect that model provider first");
    const resolved = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      credential,
      provider,
      modelId,
      registerSecrets,
      { requireStoredSecret },
    );
    return {
      provider,
      id: modelId,
      apiKey: resolved.oauth ? undefined : resolved.apiKey,
      baseUrl: resolved.baseUrl,
      allowPrivateEndpoint: resolved.allowPrivateEndpoint,
      cacheCapabilities: resolved.cacheCapabilities,
      contextWindow: resolved.contextWindow,

      reasoning: resolved.reasoning,
      maxTokens: resolved.maxTokens,
      acceptsImages: resolved.acceptsImages,
      maxImagesPerPrompt: resolved.maxImagesPerPrompt,
      thinkingLevel:
        ((credential.defaultModel === modelId
          ? credential.thinkingLevel
          : null) as AgentRunRequest["model"]["thinkingLevel"]) ??
        resolved.thinkingLevel ??
        null,
      oauth: resolved.oauth
        ? {
            credential: resolved.oauth,
            persist: resolved.persistOAuth,
            retire: resolved.retireOAuth,
          }
        : undefined,
    };
  };
  return {
    resolveConnectedModel,
    contextStrategy,
    async resolveModel(scope: {
      userId: string;
      spaceId: string;
      botId?: string;
    }): Promise<AgentRunRequest["model"]> {
      const override = scope.botId
        ? await deps.prisma.bot.findFirst({
            where: {
              id: scope.botId,
              userId: scope.userId,
              spaceId: scope.spaceId,
            },
            select: { modelProvider: true, modelId: true, thinkingLevel: true },
          })
        : null;
      const hasOverride = Boolean(override?.modelProvider && override.modelId);
      const [overrideCredential, defaultCredential, settings] = await Promise.all([
        hasOverride
          ? findConnectedModelCredential(
              deps.prisma,
              deps.secretStore,
              scope,
              override!.modelProvider!,
              override!.modelId,
            )
          : Promise.resolve(null),
        findDefaultModelCredential(deps.prisma, scope),
        deps.prisma.deploymentSettings.findUnique({
          where: { id: "default" },
        }),
      ]);
      const selected = selectConfiguredModel({
        override,
        overrideCredential,
        defaultCredential,
        settings,
        deployment: deps.deploymentModelConfigured ? resolveDeploymentModel() : null,
      });
      const { credential, thinkingLevel } = selected;
      let { provider, id } = selected;
      if (!provider || !id) {
        const runtimeFallback = runtimeFallbackModel(deps.runtime);
        provider ??= runtimeFallback?.provider;
        id ??= runtimeFallback?.id ?? null;
      }
      if (!provider || !id) throw new Error(MISSING_MODEL_MESSAGE);
      // The key is resolved for the provider that won above, not before it is known.
      const resolved = await resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        credential,
        provider,
        id,
      );
      return {
        provider,
        id,
        apiKey: resolved.oauth ? undefined : resolved.apiKey,
        baseUrl: resolved.baseUrl,
        allowPrivateEndpoint: resolved.allowPrivateEndpoint,
        cacheCapabilities: resolved.cacheCapabilities,
        contextWindow: resolved.contextWindow,

        reasoning: resolved.reasoning,
        maxTokens: resolved.maxTokens,
        acceptsImages: resolved.acceptsImages,
        maxImagesPerPrompt: resolved.maxImagesPerPrompt,
        thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
        oauth: resolved.oauth
          ? {
              credential: resolved.oauth,
              persist: resolved.persistOAuth,
              retire: resolved.retireOAuth,
            }
          : undefined,
      };
    },

    async wakeRoutine(routineId: string, scheduledFor: string) {
      const scheduledAt = new Date(scheduledFor);
      if (!Number.isFinite(scheduledAt.getTime())) return;
      const routine = await deps.prisma.routine.findUnique({
        where: { id: routineId },
      });
      if (!routine?.active || routine.nextRunAt?.getTime() !== scheduledAt.getTime()) return;
      if (await deferFutureRoutine(deps.jobs, routineId, scheduledAt)) return;
      const bot = await deps.prisma.bot.findUnique({
        where: { id: routine.botId },
        include: { thread: true },
      });
      if (bot?.archivedAt) {
        // Archiving pauses a bot's routines; re-pause one that slipped back to active.
        await deps.prisma.routine.updateMany({
          where: { id: routine.id, active: true },
          data: { active: false, nextRunAt: null },
        });
        return;
      }
      if (!bot?.thread) return;
      const targetThread = routine.threadId
        ? await deps.prisma.thread.findFirst({
            where: {
              id: routine.threadId,
              spaceId: routine.spaceId,
              OR: [
                { botId: bot.id },
                {
                  group: {
                    archivedAt: null,
                    members: { some: { botId: bot.id } },
                  },
                },
              ],
            },
            select: { id: true },
          })
        : null;
      const thread = targetThread ?? bot.thread;
      // A change trigger checks first, without a model; only news becomes a run.
      const watchTick =
        routine.watch == null
          ? null
          : await tickRoutineWatch(
              { ...deps, commandRefusal: protectedComputerLifecycleRefusal },
              routine,
              { threadId: thread.id, botId: bot.id },
              scheduledAt,
            );
      if (watchTick && !watchTick.run) return;
      // A schedule with no valid parseable cron among its crons (e.g. a
      // legacy row accepted before cron validation was added) fires the
      // already-due run once, then nextRunAt stays null and the routine
      // pauses rather than crash-looping the wakeup job.
      const nextRunAt = watchTick?.run
        ? watchTick.nextRunAt
        : isOneShotRoutineCrons(routine.crons)
          ? null
          : nextCronDateAcross(
              routine.crons,
              new Date(Math.max(Date.now(), scheduledAt.getTime())),
              routine.timezone,
            );
      const previousLastRunAt = routine.lastRunAt;
      const skillRecords = await listAgentSkillRecords(deps.prisma, {
        spaceId: routine.spaceId,
        userId: routine.userId,
      });
      const routinePrompt =
        expandSkillReferencesInPrompt(routine.prompt, skillRecords) +
        (watchTick?.run ? watchTick.note : "");
      const claimed = await deps.prisma.$transaction(async (tx) => {
        const updated = await tx.routine.updateMany({
          where: {
            id: routine.id,
            active: true,
            nextRunAt: scheduledAt,
            bot: { archivedAt: null },
          },
          data: {
            lastRunAt: new Date(),
            nextRunAt,
            ...(nextRunAt ? {} : { active: false }),
            ...(watchTick?.run ? { watchState: watchTick.state } : {}),
          },
        });
        if (updated.count !== 1) return null;
        // The claim locks the row, so this is the model that was committed when it fired.
        const currentModel = await tx.routine.findUnique({
          where: { id: routine.id },
          select: { modelProvider: true, modelId: true, thinkingLevel: true },
        });
        if (!currentModel) return null;
        const task = await tx.task.create({
          data: {
            spaceId: routine.spaceId,
            botId: bot.id,
            threadId: thread.id,
            userId: routine.userId,
            prompt: routinePrompt,
            status: "queued",
          },
        });
        return tx.run.create({
          data: {
            spaceId: routine.spaceId,
            botId: bot.id,
            threadId: thread.id,
            taskId: task.id,
            userId: routine.userId,
            status: "queued",
            trigger: "routine",
            runtime: bot.runtime ?? deps.runtime.describe().id,
            routineId: routine.id,
            ...routineRunModelPin(currentModel),
          },
        });
      });
      if (!claimed) return;
      // Enqueue continuation first so a thread-signal failure cannot strand the run.
      try {
        await deps.jobs.enqueue(runContinueJob(claimed.id));
      } catch (error) {
        // Restore the claim so wakeup retry / routine reconciliation can fire again.
        await deps.prisma.$transaction(async (tx) => {
          await tx.run.deleteMany({
            where: { id: claimed.id, status: "queued" },
          });
          await tx.task.deleteMany({
            where: { id: claimed.taskId, status: "queued" },
          });
          await tx.routine.updateMany({
            where: {
              id: routine.id,
              nextRunAt,
              ...(nextRunAt ? {} : { active: false }),
            },
            data: {
              nextRunAt: scheduledAt,
              active: true,
              lastRunAt: previousLastRunAt,
              // Put the old fingerprint back too, or the retry would see no change.
              ...(watchTick?.run
                ? { watchState: (routine.watchState as Prisma.InputJsonValue) ?? Prisma.DbNull }
                : {}),
            },
          });
        });
        throw error;
      }
      try {
        await deps.events.append({
          spaceId: routine.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "routine.fired",
          runId: claimed.id,
          payload: { routineId: routine.id, scheduledFor },
        });
      } catch {
        // Best effort: the run is already queued.
      }
      if (isOneShotRoutineCrons(routine.crons)) {
        try {
          await deps.jobs.cancel(routineJobKey(routine.id));
        } catch {
          // Best effort: the run is already queued for continuation.
        }
      } else if (nextRunAt) {
        await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
      }
    },

    async notifyRoutineRetryAttemptsExhausted(runId: string) {
      const failed = await deps.prisma.run.findUnique({ where: { id: runId } });
      if (
        !failed?.routineId ||
        failed.trigger !== "routine" ||
        failed.status !== "failed" ||
        failed.retryOfRunId
      ) {
        return;
      }
      const supersedingRun = await deps.prisma.run.findFirst({
        where: {
          OR: [
            { retryOfRunId: failed.id },
            { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
          ],
        },
        select: { id: true },
      });
      if (supersedingRun) return;
      await notifyFailedRoutineRun(deps, failed, { retryOnFailure: true });
    },

    async retryRoutineRun(runId: string) {
      const failed = await deps.prisma.run.findUnique({ where: { id: runId } });
      if (
        !failed?.routineId ||
        failed.trigger !== "routine" ||
        failed.status !== "failed" ||
        failed.retryOfRunId
      ) {
        return;
      }
      const routine = await deps.prisma.routine.findUnique({
        where: { id: failed.routineId },
        select: {
          active: true,
          crons: true,
          nextRunAt: true,
          bot: { select: { archivedAt: true } },
        },
      });
      const laterRun = await deps.prisma.run.findFirst({
        where: { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
        select: { id: true },
      });
      if (laterRun) return;
      const notifyAbandonedRetry = () =>
        notifyFailedRoutineRun(deps, failed, { retryOnFailure: true });
      if (routine && routineNextRunIsNear(routine.nextRunAt, Date.now())) {
        await notifyAbandonedRetry();
        return;
      }
      // A one-time routine turns itself off when it fires, so only a recurring one counts as paused.
      if (
        !routine ||
        (!routine.active && !isOneShotRoutineCrons(routine.crons)) ||
        routine.bot.archivedAt
      ) {
        await notifyAbandonedRetry();
        return;
      }
      const task = await deps.prisma.task.findUnique({
        where: { id: failed.taskId },
        select: { prompt: true },
      });
      if (!task) {
        await notifyAbandonedRetry();
        return;
      }
      let retry: { id: string; taskId: string } | null;
      try {
        retry = await deps.prisma.$transaction(async (tx) => {
          // Claim the still-eligible routine without changing its state. One-shot routines
          // may already be inactive; match their crons so an edit cannot revive a paused routine.
          const claimed = await tx.routine.updateMany({
            where: {
              id: failed.routineId!,
              active: routine.active,
              ...(!routine.active ? { crons: { equals: routine.crons } } : {}),
              bot: { archivedAt: null },
            },
            data: { active: routine.active },
          });
          if (claimed.count !== 1) return null;
          const laterRun = await tx.run.findFirst({
            where: { routineId: failed.routineId!, createdAt: { gt: failed.createdAt } },
            select: { id: true },
          });
          if (laterRun) return null;
          const targetThread = await tx.thread.findFirst({
            where: {
              id: failed.threadId,
              spaceId: failed.spaceId,
              OR: [
                { botId: failed.botId },
                {
                  group: {
                    archivedAt: null,
                    members: { some: { botId: failed.botId } },
                  },
                },
              ],
            },
            select: { id: true },
          });
          if (!targetThread) return null;
          const retryTask = await tx.task.create({
            data: {
              spaceId: failed.spaceId,
              botId: failed.botId,
              threadId: failed.threadId,
              userId: failed.userId,
              prompt: task.prompt,
              status: "queued",
            },
          });
          return tx.run.create({
            data: {
              spaceId: failed.spaceId,
              botId: failed.botId,
              threadId: failed.threadId,
              taskId: retryTask.id,
              userId: failed.userId,
              status: "queued",
              trigger: "routine",
              routineId: failed.routineId,
              retryOfRunId: failed.id,
              runtime: failed.runtime ?? null,
              ...(failed.modelPinned
                ? {
                    modelProvider: failed.modelProvider,
                    modelId: failed.modelId,
                    thinkingLevel: failed.thinkingLevel,
                    modelPinned: true,
                  }
                : {}),
            },
          });
        });
      } catch (error) {
        // retryOfRunId is unique: another delivery of this job already queued the retry.
        if (isUniqueViolation(error)) return;
        throw error;
      }
      if (!retry) {
        const laterRun = await deps.prisma.run.findFirst({
          where: { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
          select: { id: true },
        });
        if (laterRun) return;
        await notifyAbandonedRetry();
        return;
      }
      try {
        await deps.jobs.enqueue(runContinueJob(retry.id));
      } catch (error) {
        // Remove the retry so the job queue's own retry of this job can queue it again.
        const queuedRetry = retry;
        await deps.prisma.$transaction(async (tx) => {
          const removed = await tx.run.deleteMany({
            where: { id: queuedRetry.id, status: "queued" },
          });
          if (removed.count === 1) {
            await tx.task.deleteMany({ where: { id: queuedRetry.taskId, status: "queued" } });
          }
        });
        throw error;
      }
    },

    async continueRun(runId: string, workerId: string) {
      const run = await deps.prisma.run.findUnique({ where: { id: runId } });
      if (!run) return;
      // Logs and security events raised by this run's tools name its account and space.
      enrichLogContext({
        "run.id": runId,
        "space.id": run.spaceId,
        ...(run.userId ? { "user.id": run.userId } : {}),
      });
      if (isTerminal(run.status as RunStatus)) return;
      let { resumeCheckpoint, heldForTakeover, resumeHeldLease, takeoverResume } =
        takeoverContinuePlan(run);

      const fence = nextFence(run.leaseFence);
      const now = new Date();
      const leased = await deps.prisma.run.updateMany({
        where: {
          id: runId,
          ...continueRunClaimFence(run),
          OR: [
            { status: { in: ["queued", "waiting_input", "waiting_takeover"] } },
            {
              status: { in: ["leased", "running"] },
              leaseExpiresAt: { lte: now },
            },
          ],
        },
        data: {
          status: "leased",
          leaseOwner: workerId,
          leaseFence: fence,
          leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
          error: null,
          checkpoint: null,
        },
      });
      if (leased.count !== 1) return;

      const current = await deps.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      if (
        current.status === "queued" ||
        current.status === "leased" ||
        current.status === "waiting_input" ||
        current.status === "waiting_takeover"
      ) {
        assertTransition(current.status as RunStatus, "running");
      }
      const started = await deps.prisma.run.updateMany({
        where: {
          id: runId,
          status: "leased",
          leaseOwner: workerId,
          leaseFence: fence,
        },
        data: { status: "running", startedAt: current.startedAt ?? new Date() },
      });
      if (started.count !== 1) return;
      const leaseTarget = await deps.prisma.bot.findUniqueOrThrow({
        where: { id: run.botId },
        select: {
          computerId: true,
          computerSwitching: true,
          computer: { select: { scope: true } },
        },
      });
      if (!leaseTarget.computerId) throw new Error("Bot has no computer");
      if (leaseTarget.computerSwitching) {
        await requeueComputerRun(deps, runId, workerId, fence, resumeCheckpoint, heldForTakeover);
        return;
      }
      if (takeoverResume) {
        await settleReleasedTakeoverCards(
          deps.prisma,
          {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            runId,
            reason: takeoverResume.checkpoint,
          },
          (threadId, seq) => deps.events.notify(threadId, seq),
        );
      }
      let computerLease: ComputerExecutionLease | null = null;
      try {
        computerLease = await acquireComputerExecutionLease(deps.prisma, {
          computerId: leaseTarget.computerId,
          runId,
          botId: run.botId,
          resumeHeldLease,
        });
        if (!computerLease && leaseTarget.computer?.scope === "dedicated") {
          computerLease = await acquireDedicatedScreenLeaseFence(deps.prisma, {
            computerId: leaseTarget.computerId,
            runId,
            botId: run.botId,
            workerId,
            runFence: fence,
          });
        }
      } catch (error) {
        if (!(error instanceof ComputerBusyError)) throw error;
        await requeueComputerRun(deps, runId, workerId, fence, resumeCheckpoint, heldForTakeover);
        return;
      }
      const attempt = await deps.prisma.attempt
        .create({
          data: { runId, fence, status: "running" },
        })
        .catch(async (error) => {
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
          throw error;
        });

      let leaseValid = true;
      let runCompleted = false;
      let lastLeaseCheckAt = 0;
      let retainComputerLease = false;
      let computerUseReason: "none" | "tool" | "takeover" | "script" = "none";
      let computerUseTool: string | undefined;
      let screenRelease:
        | { computer: ComputerRef; context: AdapterContext; keepWarm: boolean }
        | undefined;
      let runAbortController: AbortController | null = null;
      let detachShutdown: (() => void) | undefined;
      const heartbeat = setInterval(() => {
        if (runCompleted) return;
        void Promise.all([
          renewRunLease(deps, runId, workerId, fence),
          renewComputerExecutionLease(deps.prisma, computerLease),
        ])
          .then(([runRenewed, computerRenewed]) => {
            if (runCompleted) return;
            if (!runRenewed || !computerRenewed) {
              leaseValid = false;
              runAbortController?.abort();
            }
          })
          .catch(() => {
            if (runCompleted) return;
            leaseValid = false;
            runAbortController?.abort();
          });
      }, 60_000);
      heartbeat.unref?.();
      const stopHeartbeatAfterCompletion = () => {
        runCompleted = true;
        clearInterval(heartbeat);
      };

      const runSecrets = [...deps.secrets];
      try {
        const sourceBlocks =
          run.trigger === "messaging" && run.sourceMessageId
            ? ((
                await deps.prisma.message.findUnique({
                  where: { id: run.sourceMessageId },
                  select: { blocks: true },
                })
              )?.blocks as MessageBlock[] | undefined)
            : undefined;
        const channelId = messagingChannelId(sourceBlocks);
        const messagingChannelRun = isMessagingChannelRun(run.trigger, sourceBlocks);
        const [
          bot,
          thread,
          messages,
          peerMessage,
          task,
          storedConnections,
          defaultCredential,
          settings,
          savedSkills,
          agentSkills,
          agentSecretRows,
          initialBotCommandEnvironment,
        ] = await Promise.all([
          deps.prisma.bot.findUniqueOrThrow({
            where: { id: run.botId },
            include: { computer: true },
          }),
          deps.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } }),
          loadRunHistoryMessages(deps.prisma, run, LEGACY_HISTORY_WINDOW_SIZE, channelId),
          run.trigger === "bot_message"
            ? loadBotMessageContext(deps.prisma, run.sourceMessageId)
            : Promise.resolve(undefined),
          deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } }),
          deps.prisma.connection.findMany({
            where: { userId: run.userId, spaceId: run.spaceId },
            select: {
              id: true,
              connectorId: true,
              provider: true,
              providerRef: true,
              displayName: true,
              status: true,
            },
          }),
          findDefaultModelCredential(deps.prisma, run),
          deps.prisma.deploymentSettings.findUnique({
            where: { id: "default" },
          }),
          deps.prisma.taughtSkill.findMany({
            where: { botId: run.botId, spaceId: run.spaceId, status: "saved" },
          }),
          listAgentSkillRecords(deps.prisma, {
            spaceId: run.spaceId,
            userId: run.userId,
          }),
          deps.prisma.agentSecret.findMany({
            where: { spaceId: run.spaceId },
            select: {
              name: true,
              secret: { select: { id: true, ciphertext: true } },
            },
          }),
          loadBotCommandEnvironment(deps.prisma, deps.secretStore, run),
        ]);
        const runtime = deps.runtimeFor?.(run.runtime ?? bot.runtime) ?? deps.runtime;
        const omp = runtime.describe().id === "omp";
        if (run.runtime == null) {
          // Legacy/direct enqueues freeze their runtime once the first attempt starts.
          const pinned = await deps.prisma.run.updateMany({
            where: { id: runId, leaseOwner: workerId, leaseFence: fence, runtime: null },
            data: { runtime: runtime.describe().id },
          });
          if (pinned.count !== 1) return;
        }
        const ompWorkspace = omp
          ? ompWorkspaceDirectory(
              path.resolve(deps.dataDir ?? "./data", "omp-workspaces"),
              run.spaceId,
              bot.id,
            )
          : undefined;
        const historySearchBeforeSeq =
          contextStrategy !== "current" && run.sourceMessageId
            ? (messages.find((message) => message.id === run.sourceMessageId)?.seq ??
              (
                await deps.prisma.message.findUnique({
                  where: { id: run.sourceMessageId, threadId: thread.id },
                  select: { seq: true },
                })
              )?.seq ??
              thread.nextMessageSeq)
            : thread.nextMessageSeq;
        const agentEnvironment = await decryptAgentEnvironment(agentSecretRows, deps.secretStore);
        runSecrets.push(...Object.values(agentEnvironment));
        // Encoded forms too: read_file redacts with these values before any shell command runs.
        runSecrets.push(...commandCredentialRedactions(initialBotCommandEnvironment));
        const agentEnvironmentInstruction = formatAgentEnvironmentInstruction({
          ...agentEnvironment,
          ...initialBotCommandEnvironment,
        });
        // modelPinned distinguishes the captured choice from an attempt's recorded model.
        const modelChoice = runModelChoice(run, bot);
        const hasModelOverride = Boolean(modelChoice.modelProvider && modelChoice.modelId);
        const overrideCredential =
          hasModelOverride && modelChoice.modelProvider
            ? await findConnectedModelCredential(
                deps.prisma,
                deps.secretStore,
                run,
                modelChoice.modelProvider,
                modelChoice.modelId,
              )
            : null;
        runAbortController = new AbortController();
        if (!leaseValid) runAbortController.abort();
        if (deps.shutdownSignal?.aborted) runAbortController.abort(deps.shutdownSignal.reason);
        const onShutdown = () => runAbortController?.abort(deps.shutdownSignal?.reason);
        deps.shutdownSignal?.addEventListener("abort", onShutdown);
        detachShutdown = () => deps.shutdownSignal?.removeEventListener("abort", onShutdown);
        const composioRows = storedConnections.filter(
          (connection) => connection.connectorId === "composio",
        );
        let liveSlugs: string[] = [];
        if (needsLivePluginSync(composioRows)) {
          const listing = await loadLivePluginSlugs(deps.listConnectedPluginSlugs, run.userId);
          if (listing.ok) {
            liveSlugs = listing.slugs;
            await persistLivePluginConnections(deps.prisma, run, composioRows, listing.slugs).catch(
              () => undefined,
            );
          }
        }
        const connectedComposio = mergeConnectedPlugins(composioRows, liveSlugs);
        const connectedPlugins = selectRunConnections(
          storedConnections,
          connectedComposio.map((connection) => connection.provider),
        );
        const context = {
          operationId: runId,
          traceId: runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          runId,
          screenLeaseId: screenLeaseIdForRun(computerLease, runId, fence),
          signal: runAbortController.signal,
          ...connectedContext(connectedPlugins),
          connectedProviders: connectedComposio.map((row) => row.provider),
        };
        await deps.events.append({
          spaceId: run.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "run.started",
          runId,
          payload: { trigger: run.trigger, routineId: run.routineId },
        });

        const discoveredPromise = deps.connector
          ? deps.connector.discoverTools(context)
          : Promise.resolve([]);
        const threadContext = threadContextForRun(
          run.trigger,
          {
            messages: [...messages].reverse().map((m) => ({
              id: m.id,
              createdAt: m.createdAt?.toISOString(),
              seq: m.seq,
              role: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as
                | "user"
                | "assistant"
                | "system",
              content: messageToAgentHistoryText(m),
            })),
            summary: thread.historyCompactionSummary,
            historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
          },
          messagingChannelRun,
          run.sourceMessageId,
        );
        const compactedHistory = selectCompactedHistory({
          messages: threadContext.messages,
          summary: threadContext.summary,
          historyCompactedUpToSeq: threadContext.historyCompactedUpToSeq,
        });
        let history = compactedHistory.history.map(({ id, role, content, createdAt }) => ({
          id,
          createdAt,
          role,
          content,
        }));
        const historyMessages = messages.map((message) => ({
          id: message.id,
          role: message.role,
          runId: message.runId,
          blocks: message.blocks as MessageBlock[],
        }));
        const currentTurnMessage = userTurnMessageForRun(
          run.trigger,
          runId,
          historyMessages,
          run.sourceMessageId,
        );
        const turnBlocks = currentTurnMessage?.blocks;
        const allowSilentPeerMessage = botMessageAllowsSilence(
          peerMessage?.intent,
          peerMessage?.repliesToRequest,
        );
        const allowSilentEmptyRun =
          allowSilentPeerMessage || messagingChannelRun || runAllowsSilentEmpty(run.trigger);
        const emptyResponseText = peerMessage
          ? peerMessage.intent === "result" ||
            peerMessage.intent === "status" ||
            peerMessage.intent === "question" ||
            peerMessage.repliesToRequest
            ? `Update from ${peerMessage.fromBotName}: ${peerMessage.text}`
            : DELEGATED_EMPTY_NOTICE
          : undefined;
        const [discovered, currentTurnImages, memoryContext, scratchpadContext, ticketContext] =
          await Promise.all([
            discoveredPromise,
            loadCurrentTurnImages(deps, turnBlocks, context),
            messagingChannelRun
              ? Promise.resolve("")
              : loadAgentMemoryContext(deps.memory, bot.id, context),
            messagingChannelRun
              ? Promise.resolve("")
              : loadAgentScratchpadContext(deps, {
                  spaceId: run.spaceId,
                  botId: bot.id,
                }),
            messagingChannelRun || !deps.ticketBoardEnabled
              ? Promise.resolve(undefined)
              : loadAgentTicketContext(deps, {
                  spaceId: run.spaceId,
                  text: task.prompt,
                }),
          ]);
        if (!compactedHistory.usedLocalSummary) {
          history = history.slice(
            -historyWindowSize({
              semanticMemoryEnabled: false,
              compacted: thread.historyCompactedUpToSeq != null,
              recallSucceeded: false,
            }),
          );
        }
        const runDeployment = deps.deploymentModelConfigured ? resolveDeploymentModel() : null;
        const runtimeFallback = runtimeFallbackModel(runtime);
        const pinError = run.modelPinned
          ? pinnedModelCredentialError(modelChoice, overrideCredential)
          : undefined;
        const selected = selectConfiguredModel({
          override: modelChoice,
          overrideCredential,
          defaultCredential,
          settings,
          deployment: runDeployment,
        });
        const { credential, thinkingLevel } = selected;
        const runModelProvider = selected.provider ?? runtimeFallback?.provider;
        const runModelId = selected.id ?? runtimeFallback?.id;
        const failRunBeforeModel = (message: string) =>
          failRunBeforeTurn(
            deps,
            run,
            bot.name,
            { attemptId: attempt.id, workerId, fence },
            message,
          );
        if (pinError) {
          await failRunBeforeModel(pinError);
          return;
        }
        if (
          run.modelPinned &&
          (selected.provider !== modelChoice.modelProvider || selected.id !== modelChoice.modelId)
        ) {
          await failRunBeforeModel("Connect that model provider first");
          return;
        }
        if (!runModelProvider || !runModelId) {
          await failRunBeforeModel(MISSING_MODEL_MESSAGE);
          return;
        }
        // An incompatible saved model is a configuration error. Record it on the run.
        // Leaving it for the setup catch would retry and replace the message.
        let resolved: Awaited<ReturnType<typeof resolveModelKey>>;
        try {
          resolved = await resolveModelKey(
            deps,
            run.userId,
            run.spaceId,
            credential,
            runModelProvider,
            runModelId,
            (values) => runSecrets.push(...values),
          );
        } catch (error) {
          // A dead or account-switched credential is already deleted. Retrying
          // setup would requeue the run and might fall back to another model.
          if (!isTerminalModelSetupError(error)) throw error;
          await failRunBeforeModel(
            error instanceof Error ? error.message : "Connect the provider again.",
          );
          return;
        }
        runSecrets.push(...resolved.redact);
        // A pin stays as it was created. Unpinned runs still record the model they
        // used; modelPinned is what keeps that record from becoming the next choice.
        if (!run.modelPinned) {
          await deps.prisma.run.updateMany({
            where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
            data: { modelProvider: runModelProvider, modelId: runModelId },
          });
        }

        if (!bot.computer) throw new Error("Bot has no computer");
        const storedComputer = bot.computer;
        const computerMode = parseComputerMode(storedComputer.scope);
        const artifacts = deps.artifacts;
        const recentFilesInput = {
          context,
          computerMode,
          skipMessageId: currentTurnMessage?.id,
          maxTurns: RECENT_TURN_IMAGE_TURNS,
        };
        const runComputer = lazyRunComputer(
          async () => {
            getLogger().info("computer.requested");
            const computer = await provisionComputer(deps, storedComputer.id, context, "bot");
            screenRelease = { computer, context, keepWarm: false };
            scheduleComputerSleep(deps.jobs, storedComputer.id);
            // Earlier attachments wait for the computer's first use; every start copies them
            // again, so they need no checkpoint, and each copy logs and skips its own failure.
            if (artifacts) {
              await materializeRecentThreadFiles({ ...deps, artifacts }, history, historyMessages, {
                ...recentFilesInput,
                computer: async () => computer,
              });
            }
            return computer;
          },
          () => runAbortController?.abort(),
        );
        const computerKind = (await deps.sandbox.provisionKind?.()) ?? storedComputer.kind;
        const workspaceCheckpoint = createRunWorkspaceCheckpoint(async () => {
          if (!runComputer.ready) return;
          await checkpointRunComputerWorkspace(deps, storedComputer, runComputer.ready, context);
        });
        const pendingTurnFiles: MessageBlock[][] = [turnBlocks ?? []];
        let copyingTurnFiles = Promise.resolve();
        // Serialize copies before each tool, including attachments received while a boot is in flight.
        const getRunComputer = async (reason: "tool" | "takeover" | "script", tool?: string) => {
          if (computerUseReason === "none") {
            computerUseReason = reason;
            computerUseTool = tool && BUILTIN_AGENT_TOOL_NAMES.has(tool) ? tool : undefined;
          }
          return getLogger().withContext(
            {
              reason: computerUseReason,
              tool: computerUseTool,
              trigger: run.trigger,
              "run.id": runId,
              "computer.id": storedComputer.id,
            },
            async () => {
              const computer = await runComputer.get();
              copyingTurnFiles = copyingTurnFiles
                .catch(() => undefined)
                .then(async () => {
                  while (artifacts && pendingTurnFiles.length) {
                    const files = await materializeCurrentTurnFiles(
                      { ...deps, artifacts },
                      pendingTurnFiles[0],
                      {
                        context,
                        computer: async () => computer,
                        computerMode,
                        markWorkspaceDirty: workspaceCheckpoint.markDirty,
                      },
                    );
                    workspaceCheckpoint.markFiles(files);
                    pendingTurnFiles.shift();
                  }
                });
              await copyingTurnFiles;
              return computer;
            },
          );
        };
        let currentTurnFiles: Awaited<ReturnType<typeof listCurrentTurnFiles>> = [];
        let recentThreadFiles: Awaited<ReturnType<typeof listRecentThreadFiles>> = [];
        try {
          if (artifacts) {
            currentTurnFiles = ompWorkspace
              ? await materializeOmpAttachments(
                  { ...deps, artifacts },
                  turnBlocks,
                  context,
                  ompWorkspace,
                )
              : await listCurrentTurnFiles(deps, turnBlocks, context);
            recentThreadFiles = ompWorkspace
              ? []
              : await listRecentThreadFiles(deps, history, historyMessages, recentFilesInput);
          }
        } catch (error) {
          await workspaceCheckpoint.flush().catch(() => undefined);
          throw error;
        }
        const attachedFilesPrompt = [
          ompWorkspace && currentTurnFiles.length
            ? `Files attached to this turn are in your working directory:\n${currentTurnFiles.map((file) => `- ${file.path}`).join("\n")}`
            : currentTurnFilesInstruction(currentTurnFiles),
          recentThreadFilesInstruction(recentThreadFiles),
        ]
          .filter(Boolean)
          .join("\n\n");
        const graphical = deps.sandbox.describe().capabilities.graphical;
        // Gate on the model this run will actually call — the pair written to the run row
        // above. Deriving it a second time here dropped the deployment fallback, so a
        // vision-capable default was gated as "scripted" and lost its screenshot tools.
        const modelSeesImages = modelAcceptsImageInput(
          runModelProvider,
          runModelId,
          resolved.acceptsImages,
        );
        const acceptsImages = runtime.describe().capabilities.scripted || modelSeesImages;
        const groupContext = thread.groupId
          ? await loadGroupContext(deps.prisma, thread.groupId, {
              id: bot.id,
              name: bot.name,
            })
          : undefined;
        const hasMessagingIdentity = deps.messaging
          ? await deps.messaging.hasIdentity(bot.id)
          : false;
        const messagingContext = hasMessagingIdentity
          ? [messagingDmSurfaceNote(), messagingChannelRun ? messagingChannelPrivacyBlock() : null]
              .filter(Boolean)
              .join("\n\n")
          : undefined;
        if (heldForTakeover) {
          const held = await deps.prisma.run.findUnique({
            where: { id: runId },
            select: { status: true, checkpoint: true },
          });
          if (held) {
            ({ resumeCheckpoint, heldForTakeover, resumeHeldLease, takeoverResume } =
              refreshTakeoverContinuePlan(
                { resumeCheckpoint, heldForTakeover, resumeHeldLease, takeoverResume },
                held,
              ));
          }
        }
        const sourceMessage =
          (run.trigger === "user" || run.trigger === "follow_up") && run.sourceMessageId
            ? await deps.prisma.message.findUnique({
                where: { id: run.sourceMessageId },
                select: { clientNonce: true, role: true, blocks: true },
              })
            : null;
        // A follow-up can be queued by a bot (group handoffs); only the user's own counts.
        const ownerStartedRun = isOwnerStartedRun(run.trigger, sourceMessage?.role === "user");
        const graphicalToolsAllowed = graphical && acceptsImages && !heldForTakeover;
        const pageBrowserAllowed =
          graphical && browser.describe().capabilities.page && !heldForTakeover;
        const disabledBuiltinTools = disabledBuiltinToolSet(
          omp
            ? [
                ...(bot.disabledBuiltinTools ?? []),
                ...builtinAgentTools
                  .filter((tool) => !selectOmpHostTools([tool]).length)
                  .map((tool) => tool.name),
              ]
            : bot.disabledBuiltinTools,
        );
        const availableBuiltins = [
          ...selectBuiltinToolsForRun({
            ticketBoardEnabled: deps.ticketBoardEnabled,
            historyRetrievalEnabled: contextStrategy !== "current",
            graphicalToolsAllowed,
            pageBrowserAllowed,
            groupId: thread.groupId,
            trigger: run.trigger,
            mediaImagesEnabled: Boolean(deps.artifacts && mediaGeneration?.capabilities.images),
            mediaVideoEnabled: Boolean(deps.artifacts && mediaGeneration?.capabilities.video),
            cloudAgentEnabled: cloudAgentsEnabled(cloudAgent, run.spaceId),
            messagingChannelRun,
            disabledBuiltinTools: bot.disabledBuiltinTools,
            fleetManagement: bot.fleetManagement,
            followUpFromUser: sourceMessage?.role === "user",
          }),
          // Cross-owner agent connections only exist for chat-linked bots.
          ...(hasMessagingIdentity && !isBackgroundRunTrigger(run.trigger)
            ? agentConnectionTools.filter((tool) => !disabledBuiltinTools.has(tool.name))
            : []),
        ];
        const builtins = omp ? selectOmpHostTools(availableBuiltins) : availableBuiltins;
        const exposedConnectorTools = discovered.filter(
          (tool) => !builtinAgentTools.some((builtin) => builtin.name === tool.name),
        );
        const connectorTools = new Map(
          exposedConnectorTools.map((tool) => [tool.name, tool] as const),
        );
        let approvalRulesPromise: Promise<ActionApprovalRule[]> | undefined;
        const loadApprovalRules = () => {
          approvalRulesPromise ??= deps.prisma.actionApprovalRule
            .findMany({
              where: { spaceId: run.spaceId, createdByUserId: run.userId },
              select: { effect: true, matchKind: true, matchValue: true },
            })
            .then((rules) => rules as ActionApprovalRule[]);
          return approvalRulesPromise;
        };
        let autoReviewPreferencePromise: Promise<boolean> | undefined;
        const loadAutoReviewPreference = () => {
          autoReviewPreferencePromise ??= deps.prisma.actionAutoReviewPreference
            .findUnique({
              where: {
                spaceId_userId: {
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
              },
              select: { enabled: true },
            })
            .then((row) => row?.enabled ?? deploymentAutoReviewDefault());
          return autoReviewPreferencePromise;
        };
        // Outbound destinations this run may reach without asking. See outboundSiteGate and
        // connectorReadRequiresApproval; approvals from earlier attempts are read back from effects.
        const searchResultUrls = new Set<string>();
        // The owner's own words for this run: the message they sent, or the instructions of the
        // routine that started it. Never a bot, channel or webhook message, or a tool result.
        // These name the sites a run is given, and are all Auto Review sees of a new site's run.
        let ownerWordsPromise: Promise<string> | undefined;
        const loadOwnerWords = () => {
          ownerWordsPromise ??= (async () => {
            if (ownerStartedRun && !messagingChannelRun && sourceMessage?.role === "user") {
              return ((sourceMessage.blocks ?? []) as MessageBlock[])
                .flatMap((block) => (block.kind === "text" ? [block.text] : []))
                .join("\n");
            }
            // Saved when the routine fired, so a later edit cannot change what this run judges.
            if (run.trigger === "routine") return routineTaskInstructions(task.prompt);
            if (run.trigger === "webhook") {
              const routines = await deps.prisma.routine.findMany({
                where: { botId: bot.id, spaceId: run.spaceId, userId: run.userId },
                select: { name: true, prompt: true },
              });
              return inboundRoutinePrompts(task.prompt, routines).join("\n\n");
            }
            return "";
          })();
          return ownerWordsPromise;
        };
        let trustedSitesPromise: Promise<Set<string>> | undefined;
        const loadTrustedSites = () => {
          trustedSitesPromise ??= deps.prisma.externalEffect
            .findMany({
              where: { runId, kind: "web_fetch", status: { in: PASSED_EFFECT_STATUSES } },
              select: { request: true },
            })
            .then(async (rows) => {
              const sites = sitesInText(await loadOwnerWords());
              for (const row of rows) {
                const url = (row.request as { url?: unknown } | null)?.url;
                const site = typeof url === "string" ? urlSite(url) : undefined;
                if (site) sites.add(site);
              }
              return sites;
            });
          return trustedSitesPromise;
        };
        const routineNamesNewSite = async (prompt: string) => {
          const trusted = await loadTrustedSites();
          const rules = await loadApprovalRules();
          return [...sitesInText(prompt)].some(
            (site) => !trusted.has(site) && !siteAlwaysAllowed(rules, site),
          );
        };
        let trustedConnectorsPromise: Promise<Set<string>> | undefined;
        const loadTrustedConnectors = () => {
          const providers = connectedPlugins.map((plugin) => plugin.provider);
          trustedConnectorsPromise ??= deps.prisma.externalEffect
            .findMany({
              where: { runId, status: { in: PASSED_EFFECT_STATUSES } },
              select: { kind: true, request: true },
            })
            .then(
              (rows) =>
                new Set(
                  rows
                    .filter((row) => !BUILTIN_AGENT_TOOL_NAMES.has(row.kind))
                    .map((row) =>
                      connectorTrustKey(
                        boundDirectApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route ??
                          catalogApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route,
                        connectorKindFromToolName(row.kind, providers),
                      ),
                    ),
                ),
            );
          return trustedConnectorsPromise;
        };
        // Channel and webhook text this run took in mid-turn is not the owner's. Rows queued
        // before origins were recorded are recognized by their channel message.
        const receivedOutsideMessage = async () =>
          Boolean(
            await deps.prisma.steeringMessage.findFirst({
              where: {
                runId,
                claimedAt: { not: null },
                OR: [
                  { originTrigger: { not: null } },
                  { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
                ],
              },
              select: { id: true },
            }),
          );
        // Whether outside content has entered the run. A run someone else started begins tainted,
        // and so does a later attempt, whose earlier tool results this worker did not see.
        let runTainted = !ownerStartedRun;
        let earlierAttemptPromise: Promise<boolean> | undefined;
        const isRunTainted = async () => {
          if (runTainted) return true;
          earlierAttemptPromise ??= deps.prisma.attempt
            .count({ where: { runId } })
            .then((count) => count > 1);
          if ((await earlierAttemptPromise) || (await receivedOutsideMessage())) runTainted = true;
          return runTainted;
        };
        // The intro turn confirms how a bot read its own role before anyone hands it
        // real work — it must not be able to act on that reading (shell, computer,
        // scheduling, spawning another bot, ...) before the user has assigned any task.
        const tools = run.trigger === "created" ? [] : [...builtins, ...exposedConnectorTools];
        const taskCatalogInstruction = tools.some((tool) => tool.name === "task_catalog")
          ? TASK_CATALOG_GUIDANCE
          : undefined;
        const approvedEffects = await deps.prisma.externalEffect.findMany({
          where: { runId, status: "approved" },
          orderBy: APPROVED_EFFECT_REPLAY_ORDER,
          select: { kind: true, request: true },
        });
        const approvedEffectReplays = createApprovedEffectReplayQueue(approvedEffects);
        const baseComputerInstruction = persistentComputerInstruction({
          heldForTakeover,
          graphicalToolsAllowed,
          graphical,
          disabled: disabledBuiltinTools,
        });
        const dockerToolInstruction = dockerComputerToolInstruction(
          computerKind,
          disabledBuiltinTools,
        );
        const computerInstruction = omp
          ? "Use your native execution tools for files, commands, search, browser work, and subagents. Rakazo product tools are registered separately."
          : [
              "Use the computer only when the task needs files, commands, a browser, or an installed application. Answer directly from the conversation when sufficient; use connected tools for app data. Do not inspect the computer just to prepare for an unrelated task.",
              dockerToolInstruction
                ? `${baseComputerInstruction} ${dockerToolInstruction}`
                : baseComputerInstruction,
            ].join(" ");
        const workspaceInstruction = omp
          ? `Your persistent working directory is ${ompWorkspace}. Relative paths start there. Use attach_file to share files from this directory.`
          : computerMode === "team"
            ? `Your Team Computer home is ${teamBotWorkspaceDirectory(bot.id)}. Relative file paths and shell working directories start there. Put intentionally shared work under shared/. Other bots' folders are visible under bots/; treat them as their working areas.`
            : "This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.";

        let assembled = "";
        let currentTextSegment = "";
        let messageSegments: MessageBlock[] = [];
        // Terminal subagent rows are published as their own messages (not appended to
        // messageSegments). Treat that like tool/step durable activity so we do not invent
        // an empty-run "done." completion afterward.
        let publishedTerminalSubagent = false;
        // Durable chat messages posted mid-turn (message_user / promoted narration).
        // Rehydrate from this run's prior progress rows so a resume after ask/takeover
        // still knows progress was already published (skip hollow finals; status outcome).
        let publishedMidTurnUserMessage = false;
        // Some runs hold back pre-tool narration instead of posting it as chat.
        // Keep the last segment in case the model supplies no final reply.
        let discardedMidTurnNarration = false;
        let lastDiscardedMidTurnNarration = "";
        let explicitNoResponse = false;
        let assistantTurnText = "";
        const recordExplicitNoResponse = (text: string) => {
          explicitNoResponse ||= isExactNoResponse(text) || /\bNO_RESPONSE\b/.test(text);
        };
        const midTurnUserTexts: string[] = [];
        let midTurnProgressCount = 0;
        const turnStartedAtMs = run.startedAt?.getTime() ?? Date.now();
        // Durable interim messages only on genuinely long turns, capped per run.
        const canPublishDurableProgress = () =>
          midTurnProgressBudgetAllows(midTurnProgressCount, Date.now() - turnStartedAtMs);
        const canPublishDurableNarration = () =>
          runPromotesMidTurnNarration(run.trigger) && canPublishDurableProgress();
        {
          const priorProgress = await deps.prisma.message.findMany({
            where: { runId: run.id, role: "bot" },
            orderBy: { seq: "asc" },
            select: { blocks: true, clientNonce: true },
          });
          for (const message of priorProgress) {
            if (!isUserProgressClientNonce(message.clientNonce)) continue;
            const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
            const text = blocks
              .filter(
                (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
              )
              .map((block) => block.text)
              .join("")
              .trim();
            if (!text) continue;
            midTurnUserTexts.push(text);
            publishedMidTurnUserMessage = true;
            midTurnProgressCount += 1;
          }
        }
        // Tool calls that land mid-sentence wait here until the narration catches up to a
        // sentence boundary, so the step chips never render in the middle of a clause.
        let pendingToolNames: string[] = [];
        const flushPendingTools = () => {
          if (currentTextSegment) {
            messageSegments = appendTextSegment(messageSegments, currentTextSegment);
            currentTextSegment = "";
          }
          for (const name of pendingToolNames) {
            messageSegments = appendToolCallSegment(messageSegments, name);
          }
          pendingToolNames = [];
        };
        const tryFlushPendingTools = () => {
          if (pendingToolNames.length > 0 && endsSentence(currentTextSegment)) flushPendingTools();
        };
        let pendingProgress = "";
        let lastProgressAt = 0;
        let hasStreamedText = false;
        // Set by a tool call or a new assistant message: the next text starts a new
        // assistant turn and needs a break from the earlier text that stayed in this reply.
        let assistantTurnBreakPending = false;
        let toolCallStreak: ToolCallStreak = { key: undefined, count: 0 };
        let lastComputerFrameId: string | undefined;
        let unchangedVisualStreak: UnchangedVisualStreak = { count: 0 };
        let terminalCheckpointComplete = false;
        let approvalPausePending = false;
        let handedOff = false;
        let progressRedactor = createStreamingRedactor(runSecrets);
        const scripted = runtime.describe().capabilities.scripted;
        const script = scripted ? inferScript(task.prompt, takeoverResume?.checkpoint) : undefined;
        const flushProgress = async () => {
          // Routines may finish silently. Do not leak narration or a partial silence
          // sentinel before the final outcome is known.
          if (
            scripted ||
            !pendingProgress ||
            run.trigger === "routine" ||
            isBackgroundRunTrigger(run.trigger)
          )
            return;
          await deps.events.append({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            type: "thread.progress",
            runId,
            // The first flush replaces the "working…" placeholder outright — a delta here
            // would otherwise get appended straight onto it with no separator.
            payload: hasStreamedText
              ? { delta: pendingProgress, streaming: true }
              : { text: pendingProgress, streaming: true },
          });
          hasStreamedText = true;
          pendingProgress = "";
          lastProgressAt = Date.now();
        };
        const publishMidTurnNarration = async (beforeConnectCard = false) => {
          const extracted = extractNarrationText(messageSegments, currentTextSegment);
          const narration = clampUserProgressMessage(redactSecrets(extracted.text, runSecrets));
          const canPublish =
            canPublishDurableNarration() ||
            (beforeConnectCard && runPromotesMidTurnNarration(run.trigger));
          if (
            narration &&
            !canPublish &&
            !allowSilentEmptyRun &&
            runPromotesMidTurnNarration(run.trigger)
          ) {
            return;
          }
          messageSegments = extracted.remaining;
          currentTextSegment = "";
          if (!narration) return;
          hasStreamedText = false;
          pendingProgress = "";
          if (!canPublish) {
            assembled = "";
            discardedMidTurnNarration = true;
            lastDiscardedMidTurnNarration = narration;
            return;
          }
          assembled = "";
          await publishMessage(
            deps,
            run,
            "bot",
            [{ kind: "text", text: narration }],
            undefined,
            userProgressClientNonce(run.id, midTurnProgressCount++),
          );
          midTurnUserTexts.push(narration);
          publishedMidTurnUserMessage = true;
        };
        const formatObservation = (
          observation: Awaited<ReturnType<SandboxProvider["observe"]>>,
          note?: string,
          visualActionKey?: string,
        ) => {
          const guard = advanceUnchangedVisualGuard(
            unchangedVisualStreak,
            observation.frameId,
            visualActionKey,
          );
          unchangedVisualStreak = guard.streak;
          const result = observationToolResult(
            observation,
            note,
            lastComputerFrameId,
            visualActionKey ? { unchangedVisualCount: guard.streak.count } : undefined,
          );
          lastComputerFrameId = observation.frameId;
          return result;
        };

        const pauseForApproval = () => {
          approvalPausePending = true;
          return approvalPausedToolResult();
        };

        const pauseForSecret = () => {
          approvalPausePending = true;
          return secretPausedToolResult();
        };

        const mutatingEffectOccurrences = new Map<string, number>();
        const consumedEffectIds = new Set<string>();
        const nextMutatingEffectOccurrence = (toolName: string, args: Record<string, unknown>) => {
          const fingerprint = toolEffectIdempotencyKey(runId, toolName, args);
          const occurrence = mutatingEffectOccurrences.get(fingerprint) ?? 0;
          mutatingEffectOccurrences.set(fingerprint, occurrence + 1);
          return occurrence;
        };

        /** Fleet tools take every scope from the run, never from arguments. */
        const fleetRun: FleetRun = {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: thread.groupId ?? null,
          threadId: thread.id,
          runId,
        };

        const dispatchTool = async (
          name: string,
          args: Record<string, unknown>,
          executionId: string,
          _route?: unknown,
          observer?: AgentToolExecutionObserver,
        ) => {
          context.signal.throwIfAborted();
          if (handedOff) {
            return {
              error: "This stage was handed off. End the turn without more tool calls.",
            };
          }
          if (name === "propose_instructions_update" && approvalPausePending)
            return pauseForApproval();
          if (disabledBuiltinTools.has(name)) {
            return { error: "This tool is disabled for this bot." };
          }
          if (PAGE_BROWSER_TOOL_NAMES.has(name) && !pageBrowserAllowed) {
            return { error: "Page browser is unavailable on this computer." };
          }
          if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !acceptsImages) {
            return { error: MODEL_CANNOT_SEE_MESSAGE };
          }
          let connectorCall: ConnectorCall = {
            tool: name,
            args,
            executionId,
            route: connectorTools.get(name)?.route,
          };
          const onCatalogExecuteRoute = Boolean(
            connectorCall.route &&
              !connectorCall.route.resourceId &&
              connectorCall.route.toolName === CATALOG_EXECUTE,
          );
          const approvedReplay = approvedCatalogReplay(
            approvedEffectReplays,
            name,
            CATALOG_APPROVAL_TOOL,
            onCatalogExecuteRoute,
          );
          if (approvedReplay.error) return { error: approvedReplay.error };
          if (approvedReplay.args) connectorCall.args = approvedReplay.args;
          let catalogRemapped = false;
          let resolvedTool: ConnectorTool | undefined;
          if (name.startsWith("cloud_agent_") && !validCloudAgentArgs(name, args)) {
            return {
              error: "Invalid cloud agent arguments. Raw environment variables are not supported.",
            };
          }
          let effectRequest: unknown = args;
          if (connectorCall.route && deps.connector?.resolveCall) {
            try {
              const resolved = await deps.connector.resolveCall(connectorCall, context);
              if (resolved) {
                if (BUILTIN_AGENT_TOOL_NAMES.has(resolved.tool.name)) {
                  return {
                    error: "Connector tool name conflicts with a built-in tool",
                  };
                }
                name = resolved.tool.name;
                args = resolved.call.args;
                catalogRemapped = true;
                resolvedTool = resolved.tool;
                effectRequest = catalogApprovalRequest(
                  connectorCall.tool,
                  connectorCall.args,
                  CATALOG_APPROVAL_TOOL,
                  resolved.tool.route?.resourceId &&
                    resolved.tool.route.connectorId &&
                    resolved.tool.route.toolName
                    ? {
                        connectorId: resolved.tool.route.connectorId,
                        resourceId: resolved.tool.route.resourceId,
                        resourceRevision: resolved.tool.route.resourceRevision,
                        toolName: resolved.tool.route.toolName,
                      }
                    : undefined,
                );
                connectorCall = resolved.call;
              }
            } catch (error) {
              return { error: sanitizeConnectorError(error) };
            }
          }
          if (approvedReplay.args && !catalogRemapped) {
            return {
              error:
                "Approved catalog request could not be resolved to a tool. Deny and retry the direct tool call.",
            };
          }
          if (
            !catalogRemapped &&
            connectorCall.route?.resourceId &&
            connectorCall.route.connectorId &&
            connectorCall.route.toolName
          ) {
            effectRequest = boundDirectApprovalRequest(
              {
                connectorId: connectorCall.route.connectorId,
                resourceId: connectorCall.route.resourceId,
                resourceRevision: connectorCall.route.resourceRevision,
                toolName: connectorCall.route.toolName,
              },
              args,
              CATALOG_APPROVAL_TOOL,
            );
          }
          // Approval applies to the exact persisted request, never to a payload the model
          // reconstructs after the worker resumes. This also makes a changed reconstruction
          // hit the already-approved effect instead of creating a second approval card.
          const nextApprovedTool = approvedEffectReplays.nextToolName();
          const nextApprovedRequest = approvedEffectReplays.nextRequest();
          const liveRoute =
            connectorCall.route?.resourceId &&
            connectorCall.route.connectorId &&
            connectorCall.route.toolName
              ? {
                  connectorId: connectorCall.route.connectorId,
                  resourceId: connectorCall.route.resourceId,
                  resourceRevision: connectorCall.route.resourceRevision,
                  toolName: connectorCall.route.toolName,
                }
              : undefined;
          const nextBound = boundDirectApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
          const nextCatalog = catalogApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
          // After collision uniquify, the live tool name may differ from the stored effect
          // kind while still targeting the same bound connector resource.
          const sameBoundResource = Boolean(
            nextBound && liveRoute && approvalRoutesMatch(nextBound.route, liveRoute),
          );
          // After catalog shrink, a catalog approval may resume as the matching direct tool.
          const sameCatalogTarget = Boolean(
            nextCatalog && catalogApprovalMatchesLiveRoute(nextCatalog, liveRoute),
          );
          if (
            nextApprovedTool &&
            nextApprovedTool !== name &&
            !sameBoundResource &&
            !sameCatalogTarget
          ) {
            return {
              error: `Approved request ${nextApprovedTool} must be replayed before ${name}.`,
            };
          }
          // Drain FIFO only when the pending approval matches this path (catalog vs direct).
          const replayEffectToolName = approvalReplayEffectToolName(
            name,
            nextApprovedTool,
            sameBoundResource || sameCatalogTarget,
          );
          if (
            nextApprovedTool &&
            (nextApprovedTool === name || sameBoundResource || sameCatalogTarget)
          ) {
            const pathError = approvalReplayPathError(
              name,
              catalogRemapped,
              nextApprovedRequest,
              CATALOG_APPROVAL_TOOL,
              liveRoute,
            );
            if (pathError) return { error: pathError };
            const resourceError = approvalReplayResourceError(
              name,
              catalogRemapped,
              nextApprovedRequest,
              liveRoute,
              CATALOG_APPROVAL_TOOL,
            );
            if (resourceError) return { error: resourceError };
            const approvedRequest = approvedEffectReplays.take(nextApprovedTool)!;
            const approvedCatalog = catalogApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL);
            if (approvedCatalog && !catalogRemapped) {
              // Shrink-to-direct: restore approved inner arguments, not the wrapper envelope.
              const innerArgs = catalogApprovalInnerArgs(approvedCatalog);
              if (!innerArgs) {
                return {
                  error: `Approved catalog request ${name} is missing tool arguments.`,
                };
              }
              args = innerArgs;
            } else {
              // Catalog wrappers keep resolveCall's parsed args so Zod stripping/coercion
              // still matches the first-approval effect key and execute payload.
              args = approvedReplayArgs(approvedRequest, args, CATALOG_APPROVAL_TOOL);
            }
            // Bound / shrink-direct approvals may skip catalog parse — reject before execute
            // if they no longer match the live schema.
            if (
              boundDirectApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL) ||
              (approvedCatalog && !catalogRemapped)
            ) {
              const liveSchema = (resolvedTool ?? connectorTools.get(name))?.inputSchema;
              if (liveSchema) {
                try {
                  assertConnectorToolArgs(liveSchema, args);
                } catch (error) {
                  return { error: sanitizeConnectorError(error) };
                }
              }
            }
          }
          const fleetWrite =
            FLEET_WRITE_TOOL_NAMES_SET.has(name) ||
            (name === "update_bot" && argumentGiven(args.bot_id));
          if (fleetWrite || name === "list_fleet") {
            if (isSubagentToolExecution(executionId))
              return { error: "Helpers cannot use bot management tools." };
            // The run-start snapshot is not enough: the owner can turn the switch off mid-run.
            const live = await deps.prisma.bot.findUnique({
              where: { id: bot.id },
              select: { fleetManagement: true },
            });
            if (!live?.fleetManagement) return { error: "This tool is disabled for this bot." };
            if (!ownerStartedRun) return { error: "Bot management tools need a run you started." };
            if (fleetWrite && (await receivedOutsideMessage()))
              return {
                error:
                  "Changes to the bots you manage are blocked for the rest of this run because it received a channel or webhook message.",
              };
          }
          if (name === "propose_instructions_update") {
            try {
              if (run.trigger === "follow_up" && !ownerStartedRun)
                return {
                  error: "Instruction updates are blocked for externally triggered runs.",
                };
              if (!nextApprovedTool) validateInstructionProposal(args, run.trigger);
              else
                validateInstructionProposal(
                  { instructions: args.instructions, reason: args.reason },
                  run.trigger,
                );
              if (
                redactSecrets(String(args.instructions), runSecrets) !== args.instructions ||
                redactSecrets(String(args.reason), runSecrets) !== args.reason
              )
                return { error: "Instruction proposals cannot contain credentials." };
              const instructionProposalBot = await reserveInstructionProposal(
                deps.prisma,
                bot.id,
                runId,
              );
              if (!nextApprovedTool) {
                args = { ...args, previousInstructions: instructionProposalBot.instructions };
              }
            } catch (error) {
              return {
                error: error instanceof Error ? error.message : "Invalid instruction proposal.",
              };
            }
          }
          let fleetSummary: FleetCardSummary | undefined;
          if (isFleetApprovalTool(name) && nextApprovedTool !== name) {
            // Resolve names, members, model and schedule now; an approved replay runs the stored
            // request above and never resolves them again.
            const prepared = await prepareFleetRequest(
              fleetPrepareDeps(deps, run),
              fleetRun,
              name,
              args,
              runSecrets,
            );
            if (!prepared.ok) return { error: prepared.error };
            args = prepared.canonical;
            fleetSummary = prepared.summary;
          }
          if (name === "propose_instructions_update" || isFleetApprovalTool(name))
            effectRequest = args;
          const viaConnector = !BUILTIN_AGENT_TOOL_NAMES.has(name);
          // Declared effect of the operation this call dispatches (installed API method and
          // flag). Install config is immutable per route resource, so it cannot drift before
          // execute; a catalog call uses the tool it was just resolved to.
          const declaredReadOnly = viaConnector
            ? (resolvedTool ?? connectorTools.get(name))?.readOnly
            : undefined;
          const requiresUnattendedApproval = unattendedTriggerToolRequiresApproval(
            run.trigger,
            name,
            viaConnector,
            declaredReadOnly,
          );
          const connectorKind = connectorKindFromToolName(
            name,
            connectedPlugins.map((plugin) => plugin.provider),
          );
          const fetchUrl =
            name === "web_fetch" ? normalizedHttpUrl(String(args.url ?? "")) : undefined;
          const fetchSite = fetchUrl ? urlSite(fetchUrl) : undefined;
          if (name === "web_fetch" && !fetchSite) return { error: "url must be an http(s) URL" };
          if (fetchUrl && fetchUrl.length > MAX_FETCH_URL_LENGTH)
            return { error: `url must be at most ${MAX_FETCH_URL_LENGTH} characters` };
          // The card, the stored effect and the request all use the URL the gate checked.
          if (fetchUrl) {
            args = { ...args, url: fetchUrl };
            effectRequest = args;
          }
          const connectorTrust = connectorTrustKey(connectorCall.route, connectorKind);
          const siteGate =
            fetchUrl && fetchSite
              ? outboundSiteGate({
                  site: fetchSite,
                  trusted:
                    searchResultUrls.has(fetchUrl) || (await loadTrustedSites()).has(fetchSite),
                  rules: await loadApprovalRules(),
                })
              : "allow";
          const connectorReadGated =
            viaConnector &&
            !connectorToolRequiresApproval(name, declaredReadOnly) &&
            connectorReadRequiresApproval({
              tainted: await isRunTainted(),
              connectorTrusted: (await loadTrustedConnectors()).has(connectorTrust),
            });
          // This schedules unattended shell execution; require a person to approve
          // the command once, rather than letting an allow rule or reviewer schedule it.
          const commandWatch =
            name === "schedule_create" && commandWatchFromTool(args.watch) !== undefined;
          // A routine's prompt counts as the owner's words when it runs, so the sites it names are
          // ones its runs may fetch. Once outside content entered this run, a routine naming a
          // site this run was not given needs a person: a reviewer would judge it on this run's
          // context, and passing it would trust the site for every later run.
          const scheduleNamesNewSite =
            name === "schedule_create" &&
            (await isRunTainted()) &&
            (await routineNamesNewSite(String(args.prompt ?? "")));
          const requiresApprovalByDefault =
            commandWatch ||
            requiresUnattendedApproval ||
            siteGate === "new" ||
            connectorReadGated ||
            toolRequiresApproval(name, viaConnector, declaredReadOnly);
          const requiresMandatoryApproval =
            commandWatch ||
            scheduleNamesNewSite ||
            requiresUnattendedApproval ||
            toolRequiresExplicitApproval(name);
          const approvalResolved = requiresMandatoryApproval
            ? {
                decision: "ask" as const,
                source: "default" as const,
                matchingRules: [],
              }
            : resolveActionApprovalDetail({
                toolName: name,
                connectorKind,
                readOnly: declaredReadOnly,
                site: fetchSite,
                rules: await loadApprovalRules(),
              });
          const autoReviewPref = requiresMandatoryApproval
            ? false
            : await loadAutoReviewPreference();
          const injectedReview = requiresMandatoryApproval ? undefined : deps.autoReview;
          const checker = requiresMandatoryApproval ? undefined : resolveAutoReviewChecker();
          const checkerConfigured =
            autoReviewPref &&
            (Boolean(injectedReview) ||
              (checker
                ? isAutoReviewCheckerConfigured({}) ||
                  Boolean(
                    await findConnectedModelCredential(
                      deps.prisma,
                      deps.secretStore,
                      { userId: run.userId, spaceId: run.spaceId },
                      checker.provider,
                    ),
                  )
                : false));
          const plan = requiresMandatoryApproval
            ? "ask"
            : planActionGate({
                resolved: approvalResolved,
                consequential: requiresApprovalByDefault,
                autoReviewEnabled: autoReviewPref,
                checkerConfigured,
                newDestination: siteGate === "new",
              });
          let reviewReason: string | undefined;
          let gateDecision: "ask" | "allow" = plan === "ask" ? "ask" : "allow";
          const needsApprovalEarly = plan === "ask" || plan === "judge";
          // A resumed approval keeps its key even if "Always allow" changed the policy.
          const usesApprovalKey =
            nextApprovedTool ||
            name === "request_secret" ||
            needsApprovalEarly ||
            requiresApprovalByDefault;
          // Count before choosing a key so an approved replay (occurrence 0 / base
          // key) cannot collide with a later identical-args call in this attempt.
          // request_secret stays single-use: retries must reuse the same card.
          const occurrence =
            name === "request_secret" || name === "connect_app"
              ? 0
              : nextMutatingEffectOccurrence(replayEffectToolName, args);
          const effectKey =
            usesApprovalKey && occurrence === 0
              ? approvalEffectKey(runId, replayEffectToolName, args)
              : toolEffectIdempotencyKey(runId, replayEffectToolName, args, occurrence);
          // Connector read-only hints must not bypass approval, review, or replay decisions.
          // A fetch to a new site is gated like any action, so it needs an effect to approve.
          const applied =
            READ_ONLY_AGENT_TOOLS.has(name) && siteGate !== "new" && nextApprovedTool !== name
              ? undefined
              : await recordEffect(
                  deps,
                  run,
                  replayEffectToolName,
                  effectKey,
                  effectRequest,
                  executionId,
                  consumedEffectIds,
                );

          const runAutoReview = async () => {
            if (!injectedReview && !checker) return;
            try {
              const botDescription = redactSecrets(
                `${bot.name}: ${bot.title}\n${bot.description}`,
                runSecrets,
              );
              // A new site is judged on the full URL and the owner's own words only: the task
              // prompt of a webhook or bot-started run carries text someone else wrote.
              const reviewRequest: AutoReviewRequest =
                siteGate === "new" && fetchUrl
                  ? {
                      toolName: name,
                      connectorKind,
                      args: { url: redactSecrets(fetchUrl, runSecrets) },
                      userTask: redactSecrets(await loadOwnerWords(), runSecrets),
                      botDescription,
                      matchingRules: approvalResolved.matchingRules,
                      newSite: true,
                    }
                  : {
                      toolName: name,
                      connectorKind,
                      args: redactToolArgsForReview(args, runSecrets),
                      userTask: redactSecrets(task.prompt, runSecrets),
                      botDescription,
                      matchingRules: approvalResolved.matchingRules,
                    };
              const reviewContext: AdapterContext = {
                operationId: `auto-review:${runId}`,
                traceId: `auto-review:${runId}`,
                spaceId: run.spaceId,
                userId: run.userId,
                botId: bot.id,
                runId,
                signal: AbortSignal.any([
                  context.signal,
                  AbortSignal.timeout(autoReviewTimeoutMs()),
                ]),
              };
              let provider = injectedReview;
              if (!provider) {
                const kind = resolveAutoReviewProviderKind();
                if (kind === "jev" || kind === "scripted") {
                  provider = createAutoReviewProvider(kind);
                } else {
                  const reviewCredential = await findConnectedModelCredential(
                    deps.prisma,
                    deps.secretStore,
                    { userId: run.userId, spaceId: run.spaceId },
                    checker!.provider,
                    checker!.model,
                  );
                  const judgeKey = await resolveModelKey(
                    deps,
                    run.userId,
                    run.spaceId,
                    reviewCredential,
                    checker!.provider,
                    checker!.model,
                    (values) => runSecrets.push(...values),
                  );
                  provider = createAutoReviewProvider("llm", {
                    llm: {
                      onUsage: (event) =>
                        recordUsage(deps.prisma, event, {
                          spaceId: run.spaceId,
                          userId: run.userId,
                          botId: bot.id,
                          parentRunId: runId,
                          runId,
                          operationId: `auto-review:${runId}`,
                          operationKind: "setup",
                        }),
                      // The JSON approval judge must not acquire omp's native execution tools.
                      runtime: deps.runtimeFor?.("pi") ?? deps.runtime,
                      checker: checker!,
                      apiKey: judgeKey.oauth ? undefined : judgeKey.apiKey,
                      baseUrl: judgeKey.baseUrl,
                      allowPrivateEndpoint: judgeKey.allowPrivateEndpoint,
                      cacheCapabilities: judgeKey.cacheCapabilities,
                      contextWindow: judgeKey.contextWindow,
                      maxTokens: judgeKey.maxTokens,
                      reasoning: judgeKey.reasoning,
                      oauth: judgeKey.oauth
                        ? {
                            credential: judgeKey.oauth,
                            persist: judgeKey.persistOAuth,
                            retire: judgeKey.retireOAuth,
                          }
                        : undefined,
                      runId,
                      spaceId: run.spaceId,
                      userId: run.userId,
                      botId: bot.id,
                      threadId: thread.id,
                      timeoutMs: autoReviewTimeoutMs(),
                    },
                  });
                }
              }
              const judge = await provider.review(reviewRequest, reviewContext);
              if (context.signal.aborted) return;
              reviewReason = judge.reason;
              gateDecision = applyJudgeDecision({
                decision: judge.decision,
                consequential: requiresApprovalByDefault,
              });
              if (applied) {
                await deps.prisma.externalEffect.update({
                  where: { id: applied.effect.id },
                  data: {
                    reviewDecision: judge.decision,
                    reviewReason: judge.reason,
                    reviewModel: judge.model,
                  },
                });
              }
            } catch {
              // Cancellation must not write a review the next attempt would reuse.
              if (context.signal.aborted) return;
              // Auth/refresh failures must fail closed like a checker error, not fail the run.
              reviewReason = "Checker could not authenticate.";
              gateDecision = applyJudgeDecision({
                decision: "error",
                consequential: requiresApprovalByDefault,
              });
              if (applied) {
                await deps.prisma.externalEffect.update({
                  where: { id: applied.effect.id },
                  data: {
                    reviewDecision: "error",
                    reviewReason,
                    reviewModel: checker
                      ? `${checker.provider}/${checker.model}`
                      : (injectedReview?.describe().id ?? "auto-review"),
                  },
                });
              }
            }
          };

          if (applied && plan === "judge" && (injectedReview || checker)) {
            if (!applied.duplicate) {
              await runAutoReview();
            } else {
              const priorDecision = applied.effect.reviewDecision;
              if (priorDecision === "ask" || priorDecision === "error") {
                reviewReason =
                  typeof applied.effect.reviewReason === "string"
                    ? applied.effect.reviewReason
                    : undefined;
                gateDecision = "ask";
              } else if (priorDecision === "pass") {
                reviewReason =
                  typeof applied.effect.reviewReason === "string"
                    ? applied.effect.reviewReason
                    : undefined;
                gateDecision = "allow";
              } else {
                await runAutoReview();
              }
            }
          } else if (applied?.duplicate && plan === "ask") {
            gateDecision = "ask";
          }
          if (context.signal.aborted) return pauseForApproval();
          if (
            siteGate === "new" &&
            newSiteOutcome({ trigger: run.trigger, decision: gateDecision }) === "deny"
          ) {
            if (applied) {
              await deps.prisma.externalEffect.updateMany({
                where: { id: applied.effect.id, status: "intended" },
                data: { status: "denied" },
              });
            }
            return { error: `Fetching ${fetchSite} needs approval, and a webhook run cannot ask.` };
          }

          const needsApproval = gateDecision === "ask";
          const bypassApproval = gateDecision === "allow" && requiresApprovalByDefault;
          let claimedEffect = false;

          const callMediaTool = async (recoverOnly = false) => {
            if (
              (name !== "generate_image" && name !== "generate_video") ||
              isBackgroundRunTrigger(run.trigger) ||
              !mediaGeneration ||
              !deps.artifacts
            )
              return { error: "Media generation is unavailable." };
            const artifacts = deps.artifacts;
            return generateMediaFromTool({
              name,
              args,
              executionId: applied?.effect.id ?? executionId,
              recoverOnly,
              provider: mediaGeneration,
              prisma: deps.prisma,
              context,
              run,
              attach: (output, fileName, job) =>
                attachWorkspaceFileToThread(
                  { prisma: deps.prisma, artifacts, maxUploadSizeBytes: deps.maxUploadSizeBytes },
                  {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    botId: bot.id,
                    groupId: thread.groupId ?? undefined,
                    runId: run.id,
                    filePath: fileName,
                    bytes: output.bytes,
                    operationId: executionId,
                    onAttached: async (tx, artifact) => {
                      const checkpointed = await tx.externalEffect.updateMany({
                        where: {
                          id: job.id,
                          status: { not: "media_completed" },
                          result: { equals: job.result },
                        },
                        data: {
                          status: "media_polling",
                          result: { ...job.result, artifactId: artifact.id },
                        },
                      });
                      if (!checkpointed.count)
                        throw new Error("Media attachment was already checkpointed");
                    },
                  },
                ),
              publish: async (block, jobId, artifactId) => {
                const committed = await deps.prisma.$transaction(async (tx) => {
                  // Commit completion with the message so a restarted poll cannot post twice.
                  const claimed = await tx.externalEffect.updateMany({
                    where: { id: jobId, status: { not: "media_completed" } },
                    data: {
                      status: "media_completed",
                      result: { provider: mediaGeneration.id, artifactId },
                    },
                  });
                  if (!claimed.count) return null;
                  return persistMessageInTransaction(tx, run, "bot", [block]);
                });
                if (committed)
                  await deps.events.notify(run.threadId, committed.eventSeq).catch(() => undefined);
              },
            });
          };
          const settleToolUncertainty = async (effectId: string, toolName: string) => {
            if (name === "generate_image" || name === "generate_video") {
              const recovered = await callMediaTool(true);
              if (
                recovered !== undefined &&
                (await completeEffect(deps, effectId, "executing", recovered))
              )
                return recovered;
            }
            return settleUncertainEffect(deps.prisma, effectId, toolName, args);
          };

          const claimOrReturn = async (
            from: "approved" | "intended",
          ): Promise<unknown | undefined> => {
            const claim = from === "approved" ? claimApprovedEffect : claimIntendedEffect;
            if (await claim(deps.prisma, applied!.effect.id)) {
              claimedEffect = true;
              return undefined;
            }
            const current = await deps.prisma.externalEffect.findUnique({
              where: { id: applied!.effect.id },
            });
            if (current) {
              const retryGate = resolveDuplicateEffectGate(current, name);
              if (retryGate.action === "return") return retryGate.result;
              if (retryGate.action === "uncertain") {
                return settleToolUncertainty(applied!.effect.id, name);
              }
            }
            throw uncertainEffectError(name);
          };

          const requestApproval = async () => {
            if (!(await renewRunLease(deps, runId, workerId, fence))) {
              // Another worker owns the run now; exit without leaving a local pause card.
              return pauseForApproval();
            }
            await workspaceCheckpoint.flush();
            const paused = await deps.events.pauseRunForInput({
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              runId,
              attemptId: attempt.id,
              leaseOwner: workerId,
              leaseFence: fence,
              blocks: [
                buildApprovalAskBlock(
                  applied!.effect.id,
                  name,
                  name === "propose_instructions_update" ? { ...args, botId: bot.id } : args,
                  runSecrets,
                  { reviewReason, summary: fleetSummary },
                ),
              ],
            });
            // pauseRunForInput returning false after a successful renew means the run row no
            // longer matches this worker. Exiting via pauseForApproval() would leave the run
            // stuck in "running" with no ask card — fail instead so the user can retry.
            if (!paused) {
              throw new Error("Could not pause this run for approval; try sending again.");
            }
            if (paused.continuationRunId) {
              await deps.jobs
                .enqueue(runContinueJob(paused.continuationRunId))
                .catch((error) => getLogger().error("steering continuation enqueue", error));
            }
            await notifyRun(deps, run, {
              kind: "help",
              title: `${displayName(bot.name, "Bot")} needs approval`,
              body: `Review before ${name}`,
              botId: bot.id,
              threadId: thread.id,
            });
            return pauseForApproval();
          };

          if (applied?.duplicate) {
            const gate = resolveDuplicateEffectGate(applied.effect, name);
            if (gate.action === "return") {
              if (name === "request_secret") {
                const replacementSecret = await deps.prisma.secret.findFirst({
                  where: {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    kind: runSecretKind(runId),
                  },
                  select: { id: true, createdAt: true },
                });
                if (!replacementSecret) return gate.result;
                // Crash between persist and delete leaves the same OTP row. Do not
                // resubmit it to the connector; only newer rows are replacements.
                const effectUpdatedAt = applied.effect.updatedAt;
                if (
                  !(effectUpdatedAt instanceof Date) ||
                  resolveCompletedSecretLeftover({
                    secretCreatedAt: replacementSecret.createdAt,
                    effectUpdatedAt,
                  }) === "drop_leftover"
                ) {
                  await deps.prisma.secret.delete({
                    where: { id: replacementSecret.id },
                  });
                  return gate.result;
                }
              } else {
                return gate.result;
              }
            }
            if (gate.action === "paused") {
              if (name === "request_secret") {
                const current = await deps.prisma.run.findUnique({
                  where: { id: runId },
                  select: { status: true },
                });
                if (current?.status === "waiting_input") {
                  return pauseForSecret();
                }
                // An intended secret request resumes protected entry below, including
                // recovery after action approval but before the card was committed.
              } else if (!needsApproval) {
                const early = await claimOrReturn("intended");
                if (early !== undefined) return early;
              } else {
                const current = await deps.prisma.run.findUnique({
                  where: { id: runId },
                  select: { status: true },
                });
                if (current?.status === "waiting_input") {
                  return pauseForApproval();
                }
                return requestApproval();
              }
            } else if (gate.action === "uncertain") {
              return settleToolUncertainty(applied.effect.id, gate.toolName);
            } else if (gate.action === "execute") {
              const early = await claimOrReturn("approved");
              if (early !== undefined) return early;
            }
          } else if (needsApproval && applied) {
            return requestApproval();
          } else if (bypassApproval && applied) {
            const early = await claimOrReturn("intended");
            if (early !== undefined) return early;
          }
          // Past the gate: this destination is now one the run was given. A search result's exact
          // URL trusts only that URL, never the rest of its site.
          if (fetchSite && siteGate === "new") (await loadTrustedSites()).add(fetchSite);
          if (viaConnector) (await loadTrustedConnectors()).add(connectorTrust);
          const persistEffectResult = (result: unknown) =>
            applied
              ? completeEffect(
                  deps,
                  applied.effect.id,
                  claimedEffect ? "executing" : "intended",
                  result,
                )
              : Promise.resolve(true);
          const finish = async (result: unknown) =>
            (await persistEffectResult(result)) ? result : uncertainEffectResult(name, args);
          const registerRunSecrets = (values: string[]) => {
            const additions = values.filter((value) => !runSecrets.includes(value));
            if (additions.length === 0) return;
            pendingProgress += progressRedactor.finish();
            runSecrets.push(...additions);
            progressRedactor = createStreamingRedactor(runSecrets);
          };
          const appendComputerCommand = (payload: ComputerCommand) =>
            deps.events
              .append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId,
                type: "computer.command",
                payload,
              })
              // The Activity feed is a view; losing an entry must not fail the tool.
              // Output that arrives after the run was cancelled has no history to join.
              .catch((error: unknown) => {
                if (!(error instanceof RunHistoryWriteError)) {
                  getLogger().error("computer command event", error);
                }
              });
          /** Record a finished file/app action for the terminal's Activity view. */
          const recordComputerAction = (
            kind: Exclude<ComputerCommand["kind"], "shell">,
            target: string,
            outcome: { error?: string; bytes?: number } = {},
          ) =>
            appendComputerCommand({
              executionId,
              kind,
              command: redactSecrets(target, runSecrets),
              cwd: ".",
              status: "done",
              exitCode: outcome.error ? 1 : 0,
              output: outcome.error ? redactSecrets(outcome.error, runSecrets) : "",
              ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
            });
          if (name === "computer_observe") {
            if (heldForTakeover) {
              return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
            }
            if (await getActiveTeachingSession(deps.prisma, run.spaceId, run.botId)) {
              return {
                error: "Teaching is in progress. Stop teaching before using the computer.",
              };
            }
            return computerScreenToolResult(async () =>
              formatObservation(
                await deps.sandbox.observe(await getRunComputer("tool", name), context),
              ),
            );
          }
          if (name === "computer_act") {
            if (heldForTakeover) {
              return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
            }
            if (await getActiveTeachingSession(deps.prisma, run.spaceId, run.botId)) {
              return {
                error: "Teaching is in progress. Stop teaching before using the computer.",
              };
            }
            const actions = parseComputerActions(args.actions);
            const visualActionKey = computerVisualActionKey(actions);
            if (unchangedVisualActionBlocked(unchangedVisualStreak, actions)) {
              return finish(unchangedVisualLoopToolResult(unchangedVisualStreak));
            }
            workspaceCheckpoint.markDirty();
            return computerScreenToolResult(async () => {
              const result = await deps.sandbox.act(
                await getRunComputer("tool", name),
                {
                  actions,
                  observe: args.observe !== false,
                  settleMs: Number(args.settle_ms ?? 350),
                },
                context,
              );
              return result.observation
                ? formatObservation(
                    result.observation,
                    `completed ${result.completed} computer action${result.completed === 1 ? "" : "s"}`,
                    visualActionKey,
                  )
                : { ok: true, completed: result.completed };
            }, finish);
          }
          if (name === "list_files") {
            const requestedPath = String(args.path ?? "");
            const entries = await deps.sandbox.listFiles(
              await getRunComputer("tool", name),
              resolveBotWorkspacePath(computerMode, bot.id, requestedPath),
              context,
            );
            return {
              path: requestedPath,
              entries: entries.map((entry) => ({
                ...entry,
                path: displayBotWorkspacePath(computerMode, bot.id, requestedPath, entry.path),
              })),
            };
          }
          if (name === "read_file") {
            const filePath = String(args.path ?? "");
            const storedPath = resolveBotWorkspacePath(computerMode, bot.id, filePath);
            let bytes: Uint8Array;
            try {
              bytes = await deps.sandbox.readFile(
                await getRunComputer("tool", name),
                storedPath,
                context,
                {
                  maxBytes: MAX_MODEL_FILE_BYTES,
                },
              );
            } catch (error) {
              if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
                return {
                  error: "file is too large for model context",
                  path: filePath,
                };
              }
              throw error;
            }
            if (bytes.byteLength > MAX_MODEL_FILE_BYTES) {
              return {
                error: "file is too large for model context",
                path: filePath,
                size: bytes.byteLength,
              };
            }
            try {
              return {
                path: filePath,
                content: redactSecrets(
                  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                  runSecrets,
                ),
              };
            } catch {
              return {
                error: "file is not UTF-8 text; use open_path to inspect it",
                path: filePath,
              };
            }
          }
          if (name === "write_file") {
            const filePath = String(args.path ?? "notes/result.txt");
            if (graphical) {
              const activateRefusal = protectedActivateScriptWriteRefusal(filePath);
              if (activateRefusal) {
                return finish({ error: desktopProtectionGuardMessage(activateRefusal) });
              }
            }
            const content = new TextEncoder().encode(textContentArg(args.content, ""));
            workspaceCheckpoint.markDirty();
            try {
              await deps.sandbox.writeFile(
                await getRunComputer("tool", name),
                { path: resolveBotWorkspacePath(computerMode, bot.id, filePath), content },
                context,
              );
            } catch (error) {
              await recordComputerAction("write_file", filePath, {
                error: error instanceof Error ? error.message : "could not write file",
              });
              throw error;
            }
            await recordComputerAction("write_file", filePath, { bytes: content.byteLength });
            return finish({ ok: true, path: filePath });
          }
          if (name === "generate_image" || name === "generate_video") {
            return finish(await callMediaTool());
          }
          if (name === "render_plot") {
            if (args.charts !== undefined) {
              const query = typeof args.charts === "string" ? args.charts : undefined;
              return {
                charts: searchChartCatalog(query),
                note: "Each spec is a complete runnable example: substitute your rows and column names, then call render_plot with it.",
              };
            }
            if (args.help === true || !args.spec || typeof args.spec !== "object") {
              return { guide: PLOT_TOOL_GUIDE };
            }
            // Data and spec mistakes are the model's to fix from the returned error;
            // everything else (reading the data file, rasterizing, attaching) is ours.
            let checkingSpec = false;
            try {
              let rows = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;
              const dataPath =
                typeof args.data_path === "string" && args.data_path ? args.data_path : undefined;
              if (!rows && dataPath) {
                const bytes = await deps.sandbox.readFile(
                  await getRunComputer("tool", name),
                  resolveBotWorkspacePath(computerMode, bot.id, dataPath),
                  context,
                  { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
                );
                checkingSpec = true;
                rows = parsePlotData(dataPath, new TextDecoder().decode(bytes));
              }
              checkingSpec = true;
              assertPlotDataWithinLimits(args.spec as PlotSpec, rows);
              // jsdom and sharp load lazily so chart-free runs never pay for them.
              const { JSDOM } = await import("jsdom");
              const svg = renderPlotSpecToSvg(
                args.spec as PlotSpec,
                rows,
                new JSDOM("").window.document,
              );
              checkingSpec = false;
              const png = await plotSvgToPng(svg);
              const outPath =
                typeof args.path === "string" && args.path
                  ? args.path
                  : `charts/plot-${Date.now()}.png`;
              workspaceCheckpoint.markDirty();
              await deps.sandbox.writeFile(
                await getRunComputer("tool", name),
                {
                  path: resolveBotWorkspacePath(computerMode, bot.id, outPath),
                  content: png,
                },
                context,
              );
              let attached = false;
              const chartName = outPath.split("/").pop() ?? "chart";
              const chartRows = rows ?? (args.spec as { data?: unknown[] }).data ?? [];
              const chartSpec = { ...(args.spec as Record<string, unknown>) };
              delete chartSpec.data;
              const chartFits =
                Array.isArray(chartRows) &&
                JSON.stringify({ spec: chartSpec, data: chartRows }).length <= 200_000;
              if (args.attach !== false && chartFits) {
                // Live inline chart: the client re-renders the validated spec
                // and the PNG stays on disk as the exportable copy.
                await publishMessage(deps, run, "bot", [
                  {
                    kind: "chart",
                    name: chartName,
                    spec: chartSpec,
                    data: chartRows,
                  },
                ]);
                attached = true;
              } else if (args.attach !== false && deps.artifacts) {
                const result = await attachWorkspaceFileToThread(
                  {
                    prisma: deps.prisma,
                    artifacts: deps.artifacts,
                    maxUploadSizeBytes: deps.maxUploadSizeBytes,
                  },
                  {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    botId: bot.id,
                    runId: run.id,
                    filePath: outPath,
                    bytes: png,
                    operationId: executionId,
                  },
                );
                await publishMessage(deps, run, "bot", [result.block]);
                attached = true;
              }
              return finish({ ok: true, path: outPath, attached });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!checkingSpec)
                getLogger().error(`render_plot failed for bot ${bot.id}: ${message}`);
              return finish({
                error: message,
                hint: 'Call render_plot with {"charts": true} for runnable example specs, or {"help": true} for the full guide.',
              });
            }
          }
          if (name === "attach_file") {
            const filePath = String(args.path ?? "");
            const failAttach = async (error: string) => {
              await recordComputerAction("attach_file", filePath, { error });
              return finish({ error, path: filePath });
            };
            if (!deps.artifacts) return failAttach("artifact storage unavailable");
            const storedPath = resolveBotWorkspacePath(computerMode, bot.id, filePath);
            let bytes: Uint8Array;
            try {
              bytes = ompWorkspace
                ? await readOmpAttachment(
                    ompWorkspace,
                    filePath,
                    deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES,
                  )
                : await deps.sandbox.readFile(
                    await getRunComputer("tool", name),
                    storedPath,
                    context,
                    { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
                  );
            } catch {
              return failAttach("file not found or unreadable");
            }
            const mimeType = inferAttachmentMimeType(filePath);
            if (!mimeType) return failAttach("unsupported attachment type");
            try {
              const attached = await attachWorkspaceFileToThread(
                {
                  prisma: deps.prisma,
                  artifacts: deps.artifacts,
                  maxUploadSizeBytes: deps.maxUploadSizeBytes,
                },
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                  botId: bot.id,
                  groupId: thread.groupId ?? undefined,
                  runId: run.id,
                  filePath,
                  bytes,
                  operationId: executionId,
                  name: typeof args.name === "string" ? args.name : undefined,
                  description: typeof args.description === "string" ? args.description : undefined,
                },
              );
              await publishMessage(deps, run, "bot", [attached.block]);
              await recordComputerAction("attach_file", filePath);
              return finish({ ok: true, artifactId: attached.artifactId, path: filePath });
            } catch (error) {
              return failAttach(error instanceof Error ? error.message : "could not attach file");
            }
          }
          if (name === "shell") {
            const command = String(args.command ?? args.cmd ?? "");
            const refusal = protectedComputerLifecycleRefusal(command);
            if (graphical && refusal) {
              return finish({ error: desktopProtectionGuardMessage(refusal) });
            }
            const cwd = resolveBotWorkspaceCwd(
              computerMode,
              bot.id,
              args.cwd ? String(args.cwd) : undefined,
            );
            // Loaded per command so a command variable added, replaced, or removed mid-run
            // applies to the next command. Registered for redaction before anything runs.
            const commandEnvironment = await shellCommandEnvironment({
              prisma: deps.prisma,
              secretStore: deps.secretStore,
              scope: run,
              spaceEnvironment: agentEnvironment,
              registerRedactions: registerRunSecrets,
            });
            workspaceCheckpoint.markDirty();
            const commandEvent = {
              executionId,
              kind: "shell" as const,
              command: redactSecrets(command, runSecrets),
              cwd: redactSecrets(cwd ?? ".", runSecrets),
            };
            await appendComputerCommand({
              ...commandEvent,
              status: "running",
              exitCode: null,
              output: "",
            });
            try {
              let latestOutput = "";
              let lastPublishedAt = 0;
              let publishTimer: ReturnType<typeof setTimeout> | undefined;
              const clearPublishTimer = () => {
                if (publishTimer) clearTimeout(publishTimer);
                publishTimer = undefined;
              };
              const publishRunning = (output: string, immediate = false) => {
                latestOutput = output.slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS);
                const send = () => {
                  clearPublishTimer();
                  lastPublishedAt = Date.now();
                  void appendComputerCommand({
                    ...commandEvent,
                    status: "running",
                    exitCode: null,
                    output: latestOutput,
                  });
                };
                if (immediate || Date.now() - lastPublishedAt >= 400) {
                  send();
                  return;
                }
                if (!publishTimer) publishTimer = setTimeout(send, 400);
              };
              const commandOutput = (
                snapshot: { stdout: string; stderr: string },
                withholdPartial: boolean,
              ) => {
                const safe = redactShellStreams(snapshot, runSecrets, { withholdPartial });
                return `${safe.stdout}${safe.stderr}`;
              };
              const computer = await getRunComputer("tool", name);
              const observed = await observeShellCommand(
                deps.sandbox.execute(
                  computer,
                  {
                    argv: [
                      "bash",
                      "-c",
                      BACKGROUND_WORK_LAUNCH,
                      "rakazo-background-launch",
                      // Marker id must match sleepComputerIfIdle's probe (DB id), not ComputerRef.id
                      // (providerRef via toComputerRef). Scope launches to this run for cancel teardown.
                      storedComputer.id,
                      runId,
                      randomUUID(),
                      command,
                    ],
                    cwd,
                    env:
                      Object.keys(commandEnvironment.env).length > 0
                        ? commandEnvironment.env
                        : undefined,
                    unsetEnv: commandEnvironment.unsetEnv,
                    timeoutMs: sandboxCommandTimeoutMs(),
                  },
                  context,
                ),
                {
                  secrets: runSecrets,
                  onOutput: (snapshot) => {
                    const output = commandOutput(snapshot, true);
                    if (output) publishRunning(output);
                  },
                },
              );
              if (observed.completion) {
                const completion = observed.completion.then(async (final) => {
                  clearPublishTimer();
                  await appendComputerCommand({
                    ...commandEvent,
                    status: "done",
                    exitCode: final.code,
                    output: commandOutput(final, false).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
                  });
                  return final;
                });
                void completion.catch(() => undefined);
                publishRunning(commandOutput(observed.result, true), true);
                const returned = await finish({
                  stdout: observed.result.stdout,
                  stderr: observed.result.stderr,
                  code: null,
                  running: true,
                  notice: SHELL_STILL_RUNNING_NOTICE,
                });
                if (isRunningShellCommand(returned)) observer?.onShellStillRunning?.(completion);
                return returned;
              }
              clearPublishTimer();
              const redacted = observed.result;
              await appendComputerCommand({
                ...commandEvent,
                status: "done",
                exitCode: redacted.code,
                output: commandOutput(redacted, false).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
              });
              return finish(redacted);
            } catch (error) {
              await appendComputerCommand({
                ...commandEvent,
                status: "done",
                exitCode: 1,
                output: redactSecrets(
                  error instanceof Error ? error.message : "command failed",
                  runSecrets,
                ).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
              });
              throw error;
            }
          }
          if (name === "open_path") {
            if (heldForTakeover) {
              return finish({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
            }
            const requestedPath = String(args.path ?? "");
            workspaceCheckpoint.markDirty();
            return computerScreenToolResult(async () => {
              try {
                const result = await deps.sandbox.act(
                  await getRunComputer("tool", name),
                  {
                    actions: [
                      {
                        kind: "open",
                        path: /^https?:\/\//i.test(requestedPath)
                          ? requestedPath
                          : resolveBotWorkspacePath(computerMode, bot.id, requestedPath),
                      },
                    ],
                    observe: true,
                    settleMs: 600,
                  },
                  context,
                );
                await recordComputerAction("open_path", requestedPath);
                return result.observation
                  ? formatObservation(result.observation, `opened ${requestedPath}`)
                  : { ok: true };
              } catch (error) {
                await recordComputerAction("open_path", requestedPath, {
                  error: error instanceof Error ? error.message : "could not open path",
                });
                throw error;
              }
            }, finish);
          }
          if (name === "launch_app") {
            if (heldForTakeover) {
              return finish({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
            }
            const application = String(args.application ?? "");
            workspaceCheckpoint.markDirty();
            return computerScreenToolResult(async () => {
              try {
                const result = await deps.sandbox.act(
                  await getRunComputer("tool", name),
                  {
                    actions: [
                      {
                        kind: "focus",
                        application,
                        uri: args.uri ? String(args.uri) : undefined,
                      },
                    ],
                    observe: true,
                    settleMs: 600,
                  },
                  context,
                );
                await recordComputerAction("launch_app", application);
                return result.observation
                  ? formatObservation(result.observation, `launched ${application}`)
                  : { ok: true };
              } catch (error) {
                await recordComputerAction("launch_app", application, {
                  error: error instanceof Error ? error.message : "could not launch app",
                });
                throw error;
              }
            }, finish);
          }
          if (name === "remember") {
            const path = String(args.path ?? "").trim() || "MEMORY.md";
            // A fact is added to the document, never replaces it. A concurrent save
            // changes the revision, so re-read and append again.
            for (let attempt = 1; ; attempt += 1) {
              const snapshot = await deps.memory.read(
                { scope: "bot", botId: bot.id, path },
                context,
              );
              const existing = snapshot.documents[0];
              const content = appendMemoryFact(existing?.content ?? "", String(args.content ?? ""));
              if (content === (existing?.content ?? "")) return finish({ ok: true });
              try {
                await deps.memory.commit(
                  {
                    scope: "bot",
                    botId: bot.id,
                    path,
                    content,
                    expectedRevision: existing?.revision ?? 0,
                    sourceRunId: runId,
                    sourceThreadId: thread.id,
                  },
                  context,
                );
                return finish({ ok: true });
              } catch (error) {
                const message = error instanceof Error ? error.message : "";
                if (message !== MEMORY_REVISION_CONFLICT_ERROR || attempt >= 3) throw error;
              }
            }
          }
          if (name === "save_shared_memory") {
            const invalid = sharedMemorySaveError(args);
            if (invalid) return finish({ error: invalid });
            const path = String(args.path ?? "").trim();
            // The save replaces the whole document. Pass the revision just read so a
            // concurrent edit is rejected instead of overwritten.
            const snapshot = await deps.memory.read({ scope: "user", path }, context);
            const expectedRevision = snapshot.documents[0]?.revision ?? 0;
            try {
              const saved = await deps.memory.commit(
                {
                  scope: "user",
                  path,
                  content: String(args.content ?? ""),
                  expectedRevision,
                  sourceRunId: runId,
                  sourceThreadId: thread.id,
                },
                context,
              );
              return finish({ ok: true, path: saved.path, revision: saved.revision });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Could not save shared memory.";
              if (message === MEMORY_REVISION_CONFLICT_ERROR) return finish({ error: message });
              throw error;
            }
          }
          if (name === "web_search") {
            const found = await webSearchFromTool(web, context, args);
            // A result's exact URL was chosen by the search index, not by text in this run.
            for (const hit of ("results" in found && found.results) || []) {
              const url = normalizedHttpUrl(hit.url);
              if (url) searchResultUrls.add(url);
            }
            return finish(found);
          }
          if (name === "web_fetch") {
            return finish(await webFetchFromTool(web, context, args));
          }
          if (PAGE_BROWSER_TOOL_NAMES.has(name)) {
            if (heldForTakeover) {
              return finish({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
            }
            if (await getActiveTeachingSession(deps.prisma, run.spaceId, run.botId)) {
              return finish({
                error: "Teaching is in progress. Stop teaching before using the computer.",
              });
            }
            if (name !== "browser_snapshot") workspaceCheckpoint.markDirty();
            // Pages can echo a filled login (e.g. a username field), so scrub every page result.
            const redactions = () => [...runSecrets];
            const desktopTools =
              graphicalToolsAllowed && builtinOffered(disabledBuiltinTools, "computer_act");
            const tool =
              name === "browser_navigate"
                ? browserNavigateFromTool
                : name === "browser_snapshot"
                  ? browserSnapshotFromTool
                  : null;
            return computerScreenToolResult(async () => {
              const result = tool
                ? redactConnectorPayload(
                    await tool(browser, await getRunComputer("tool", name), context, args, {
                      desktopTools,
                    }),
                    redactions(),
                  )
                : await browserActFromTool(
                    browser,
                    await getRunComputer("tool", name),
                    context,
                    args,
                    {
                      desktopTools,
                      redactions,
                      // Team bots may send only their own folder or shared/ off the computer; a
                      // private computer's helper already confines uploads to its home folder.
                      uploadRoots:
                        computerMode === "team"
                          ? [teamBotWorkspaceDirectory(bot.id), "shared"]
                          : undefined,
                      resolveUploadPath: (path) =>
                        computerMode === "team"
                          ? resolveBotUploadPath(computerMode, bot.id, path)
                          : path,
                      resolveSecretFill: async (step) => {
                        const resolved = await resolveLoginFill({
                          prisma: deps.prisma,
                          secretStore: deps.secretStore,
                          scope: run,
                          name: step.secret,
                          field: step.field,
                        });
                        if ("error" in resolved) return resolved;
                        registerRunSecrets(resolved.redactions);
                        return { text: resolved.text, origin: resolved.origin };
                      },
                    },
                  );
              unchangedVisualStreak = unchangedVisualStreakAfterPageBrowser(
                unchangedVisualStreak,
                name,
                result,
              );
              return result;
            }, finish);
          }

          if (name.startsWith("cloud_agent_")) {
            return finish(
              await executeCloudAgentTool(
                { ...deps, cloudAgent },
                { ...context, operationId: effectKey, botId: bot.id },
                run,
                name,
                args,
              ),
            );
          }
          if (name === "task_catalog") {
            return taskCatalogFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              ...(thread.groupId ? { threadId: thread.id } : {}),
              tools,
            });
          }
          if (name === "scratchpad_list") {
            return listScratchpadItemsFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              includeDone: Boolean(args.includeDone),
            });
          }
          if (name === "scratchpad_add") {
            const created = await addScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              title: String(args.title ?? ""),
              status: args.status ? String(args.status) : undefined,
              notes: args.notes !== undefined ? String(args.notes) : undefined,
            });
            return finish(created);
          }
          if (name === "scratchpad_update") {
            const updated = await updateScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              itemId: String(args.itemId ?? ""),
              title: args.title !== undefined ? String(args.title) : undefined,
              status: args.status !== undefined ? String(args.status) : undefined,
              notes: args.notes !== undefined ? String(args.notes) : undefined,
            });
            return finish(updated);
          }
          if (name === "scratchpad_complete") {
            const completed = await completeScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              itemId: String(args.itemId ?? ""),
            });
            return finish(completed);
          }
          if (name === "scratchpad_remove") {
            const removed = await removeScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              itemId: String(args.itemId ?? ""),
            });
            return finish(removed);
          }
          if (name === "board_tickets") {
            return finish(
              await listBoardTickets(deps, {
                spaceId: run.spaceId,
                status: args.status !== undefined ? String(args.status) : undefined,
                assigneeBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
                cursor: args.cursor !== undefined ? String(args.cursor) : undefined,
              }),
            );
          }
          if (name === "ticket_get") {
            return finish(
              await getTicket(deps, {
                spaceId: run.spaceId,
                ref: String(args.ref ?? ""),
              }),
            );
          }
          if (name === "ticket_create") {
            return finish(
              await createTicket(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                title: String(args.title ?? ""),
                description: args.description !== undefined ? String(args.description) : undefined,
                priority: args.priority !== undefined ? String(args.priority) : undefined,
                ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
              }),
            );
          }
          if (name === "ticket_update") {
            return finish(
              await updateTicket(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                id: String(args.id ?? ""),
                title: args.title !== undefined ? String(args.title) : undefined,
                description: args.description !== undefined ? String(args.description) : undefined,
                priority: args.priority !== undefined ? String(args.priority) : undefined,
                status: args.status !== undefined ? String(args.status) : undefined,
                ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
              }),
            );
          }
          if (name === "ticket_comment") {
            return finish(
              await commentTicket(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                id: String(args.id ?? ""),
                body: String(args.body ?? ""),
              }),
            );
          }
          if (name === "schedule_create") {
            const command = commandWatchFromTool(args.watch);
            const refusal =
              command === undefined ? undefined : protectedComputerLifecycleRefusal(command);
            if (graphical && refusal)
              return finish({ error: desktopProtectionGuardMessage(refusal) });
            const created = await createScheduleFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              threadId: thread.id,
              name: String(args.name ?? ""),
              prompt: String(args.prompt ?? ""),
              timezone: args.timezone ? String(args.timezone) : undefined,
              schedule: compactScheduleInput({
                cron: args.cron,
                every: args.every,
                unit: args.unit,
                runAt: args.runAt,
                delayMinutes: args.delayMinutes,
                delaySeconds: args.delaySeconds,
                watch: args.watch,
              }),
            });
            return finish(created);
          }
          if (name === "schedule_list") {
            return listSchedulesFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              ...(thread.groupId ? { threadId: thread.id } : {}),
            });
          }
          if (name === "schedule_cancel") {
            const cancelled = await cancelScheduleFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              ...(thread.groupId ? { threadId: thread.id } : {}),
              routineId: args.routineId ? String(args.routineId) : undefined,
              name: args.name ? String(args.name) : undefined,
            });
            return finish(cancelled);
          }
          if (name === "skill_read") {
            return skillReadFromTool(
              deps.prisma,
              {
                spaceId: run.spaceId,
                userId: run.userId,
              },
              {
                name: args.name ? String(args.name) : undefined,
                skillId: args.skillId ? String(args.skillId) : undefined,
              },
            );
          }
          if (name === "skill_create") {
            return finish(
              await skillCreateFromTool(
                deps.prisma,
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
                {
                  name: args.name ? String(args.name) : undefined,
                  description: args.description ? String(args.description) : undefined,
                  body: args.body ? String(args.body) : undefined,
                  content: args.content ? String(args.content) : undefined,
                },
              ),
            );
          }
          if (name === "skill_update") {
            return finish(
              await skillUpdateFromTool(
                deps.prisma,
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
                {
                  name: args.name ? String(args.name) : undefined,
                  skillId: args.skillId ? String(args.skillId) : undefined,
                  newName: args.newName ? String(args.newName) : undefined,
                  description:
                    args.description !== undefined ? String(args.description) : undefined,
                  body: args.body !== undefined ? String(args.body) : undefined,
                  content: args.content ? String(args.content) : undefined,
                },
              ),
            );
          }
          if (name === "skill_delete") {
            return finish(
              await skillDeleteFromTool(
                deps.prisma,
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
                {
                  name: args.name ? String(args.name) : undefined,
                  skillId: args.skillId ? String(args.skillId) : undefined,
                },
              ),
            );
          }
          if (name === "add_mcp_server") {
            const parsed = parseMcpServerToolArgs(args);
            if (!parsed) {
              return finish({
                error:
                  "Invalid MCP server details. Required: name, transport (streamable_http|sse|stdio); endpoint for remote transports; command for stdio.",
              });
            }
            if (parsed.endpoint) {
              try {
                await assertSafeRemoteUrl(parsed.endpoint, deps.secretHttp?.resolveHostname, {
                  allowPrivateEndpoint: await actorMayUsePrivateEndpoint(
                    deps.prisma,
                    run.userId,
                    deps.mcpAllowPrivateEndpoint === true,
                  ),
                });
              } catch (error) {
                return finish({
                  error: error instanceof Error ? error.message : "Invalid MCP endpoint",
                });
              }
            }
            if (!deps.secretStore) {
              return finish({
                error: "Secret storage is not available in this deployment.",
              });
            }
            const credentialBlob = buildMcpCredentialBlob(parsed);
            let storedCredential: { id: string; ciphertext: string } | null = null;
            if (credentialBlob) {
              storedCredential = await deps.secretStore.put(credentialBlob, {
                operationId: executionId,
                traceId: executionId,
                spaceId: run.spaceId,
                userId: run.userId,
                botId: bot.id,
                signal: new AbortController().signal,
              });
            }
            const oauthLikely = needsOAuthProbe(parsed);
            let serverRow: McpServer;
            let approvalEventSeq: number | undefined;
            try {
              const created = await deps.prisma.$transaction(async (tx) => {
                if (storedCredential) {
                  await tx.secret.create({
                    data: {
                      id: storedCredential.id,
                      userId: run.userId,
                      spaceId: run.spaceId,
                      kind: "mcp",
                      ciphertext: storedCredential.ciphertext,
                    },
                  });
                }
                const server = await tx.mcpServer.create({
                  data: {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    slug: parsed.slug,
                    name: parsed.name,
                    description: parsed.description,
                    transport: parsed.transport,
                    endpoint: parsed.endpoint ?? null,
                    command: parsed.command ?? null,
                    args: parsed.args as unknown as Prisma.InputJsonValue,
                    env: Object.fromEntries(Object.keys(parsed.env).map((key) => [key, true])),
                    headers: Object.fromEntries(
                      Object.keys(parsed.headers).map((key) => [key, true]),
                    ),
                    secretId: storedCredential?.id,
                    enabled: true,
                  },
                });
                if (!parsed.assignToSelf) return { server };
                const blocks: MessageBlock[] = [
                  {
                    kind: "mcp_approval",
                    name: server.name,
                    serverId: server.id,
                    transport: parsed.transport,
                    endpoint: parsed.endpoint ?? null,
                    needsOAuth: oauthLikely,
                    status: "pending",
                  },
                ];
                const committed = await persistMessageInTransaction(tx, run, "bot", blocks);
                return { server, eventSeq: committed.eventSeq };
              });
              serverRow = created.server;
              approvalEventSeq = created.eventSeq;
            } catch (error) {
              if (isUniqueViolation(error)) {
                return finish({
                  error: `An MCP server named "${parsed.name}" already exists. Ask the user to remove it first or pick another name.`,
                });
              }
              throw error;
            }
            if (approvalEventSeq !== undefined) {
              await deps.events.notify(run.threadId, approvalEventSeq).catch((error) => {
                getLogger().error("MCP approval realtime notification", error);
              });
            }
            return finish({
              ok: true,
              server_id: serverRow.id,
              assigned_to_self: false,
              next_step: parsed.assignToSelf
                ? oauthLikely
                  ? "An approval card was posted. The user must authorize and approve it before its tools become available."
                  : "An approval card was posted. The user must approve it before its tools become available."
                : "The server was registered without assigning it to this bot.",
            });
          }
          if (name === "search_history" || name === "read_history") {
            const scope = {
              spaceId: run.spaceId,
              userId: run.userId,
              threadId: run.threadId,
              botId: run.botId,
              channelId,
              searchBeforeSeq: historySearchBeforeSeq,
            };
            const response =
              name === "search_history"
                ? await searchHistory(deps.prisma, scope, HistorySearchInputSchema.parse(args))
                : await readHistory(deps.prisma, scope, HistoryReadInputSchema.parse(args));
            const redacted = redactConnectorPayload(response, runSecrets);
            // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
            if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
              return finish({
                untrusted: true,
                error:
                  "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
              });
            }
            return finish(redacted);
          }
          if (name === "connect_app") {
            await flushProgress();
            await publishMidTurnNarration(true);
            return finish(
              await connectApp(
                deps,
                deps.connectors?.managedProviders?.() ?? [],
                context,
                run,
                args.app,
                applied?.effect.id ?? runScopedToolExecutionId(runId, executionId),
              ),
            );
          }
          if (name === "list_secrets") return listBotSecrets(deps.prisma, run);
          if (name === "forget_secret") {
            const parsed = BotSecretName.safeParse(args.name);
            if (!parsed.success) return finish({ error: "A valid credential name is required." });
            return finish(await forgetBotSecret(deps.prisma, run, parsed.data));
          }
          if (name === "secret_request") {
            try {
              const result = await requestWithBotSecret({
                prisma: deps.prisma,
                secretStore: deps.secretStore,
                scope: run,
                request: args,
                signal: context.signal,
                remote: deps.secretHttp,
                registerRedactions: registerRunSecrets,
              });
              return finish(result);
            } catch {
              return finish({ error: "Invalid authenticated request." });
            }
          }
          if (name === "request_secret") {
            const resolvedSecret = resolveRequestSecretDestination(args);
            if (resolvedSecret.error) return finish({ error: resolvedSecret.error });
            const destination = resolvedSecret.destination;
            const connectionId = resolvedSecret.connectionId;
            if (destination) {
              const existing = await findBotSecret(deps.prisma, run, destination.name);
              if (existing && !sameSecretDestination(existing, destination)) {
                return finish({
                  error: "Remove the existing credential before changing its destination.",
                });
              }
              const conflict = await findCommandVariableConflict(deps.prisma, run, destination);
              if (conflict) {
                return finish({
                  error: `Invalid credential destination — name: ${conflict} is already exported as the same variable. Choose another name.`,
                });
              }
              const submitted = botSecretSubmissionSchema({
                allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
              }).safeParse(applied?.effect.result).data;
              if (
                submitted &&
                sameSecretDestination(
                  normalizeSecretDestination(submitted.credentialSaved),
                  destination,
                )
              ) {
                return finish(
                  existing
                    ? { saved: true, ...botSecretToolView(existing) }
                    : { error: "The saved credential is no longer available." },
                );
              }
              if (existing && args.replace !== true) {
                return finish({ saved: true, ...botSecretToolView(existing) });
              }
              // Action approval authorizes showing the card; it is not a credential submission.
              // Return the claim to intended so the answer transaction can approve the saved value.
              if (claimedEffect) {
                const released = await deps.prisma.externalEffect.updateMany({
                  where: { id: applied!.effect.id, status: "executing" },
                  data: { status: "intended" },
                });
                if (released.count !== 1) return uncertainEffectResult(name);
                claimedEffect = false;
              }
            }
            const secretKind = runSecretKind(runId);
            const storedSecret = await deps.prisma.secret.findFirst({
              where: {
                spaceId: run.spaceId,
                userId: run.userId,
                kind: secretKind,
              },
            });
            if (storedSecret) {
              const plaintext = await deps.secretStore.load(
                storedSecret.ciphertext,
                storedSecret.id,
              );
              runSecrets.push(plaintext);
              // Keep the tail the old redactor still holds; a fresh instance drops it.
              pendingProgress += progressRedactor.finish();
              progressRedactor = createStreamingRedactor(runSecrets);
              const purpose = String(args.purpose ?? "otp");
              if (applied && !claimedEffect) {
                if (applied.effect.status === "intended") {
                  const early = await claimOrReturn("intended");
                  if (early !== undefined) return early;
                } else if (applied.effect.status === "approved") {
                  const early = await claimOrReturn("approved");
                  if (early !== undefined) return early;
                }
              }
              const recordedEffect = await recordEffect(deps, run, name, effectKey, args);
              if (recordedEffect?.duplicate) {
                const gate = resolveDuplicateEffectGate(recordedEffect.effect, name);
                if (gate.action === "execute") {
                  const early = await claimOrReturn("approved");
                  if (early !== undefined) return early;
                }
              }
              // Claim executing (above), take the secret, then connector complete().
              // Retries without a secret reconcile via connectionReady / settle_attempt.
              return commitConsumedRunSecret({
                deleteSecret: async () => {
                  await deps.prisma.secret.delete({
                    where: { id: storedSecret.id },
                  });
                },
                afterSecretTaken: async () => {
                  let connectionResult: { connected: boolean; error?: string } | undefined;
                  if (connectionId) {
                    connectionResult = await tryCompleteConnectionWithCode(
                      deps.prisma,
                      deps.connectors,
                      run,
                      context,
                      connectionId,
                      plaintext,
                    );
                  }
                  return purpose === "password" && !connectionId
                    ? {
                        ok: true,
                        submitted: true,
                        note: "The secret was not typed onto the computer. To reuse a website login, save it with auth type login and fill it with browser_act fill_secret; otherwise use request_takeover.",
                      }
                    : {
                        ok: true,
                        submitted: true,
                        ...(connectionResult
                          ? {
                              connected: connectionResult.connected,
                              ...(connectionResult.error
                                ? { connectionError: connectionResult.error }
                                : {}),
                            }
                          : {}),
                      };
                },
                persist: (secretResult) =>
                  applied?.duplicate && applied.effect.status === "completed"
                    ? replaceCompletedExternalEffectResult(
                        deps.prisma,
                        applied.effect.id,
                        secretResult,
                      )
                    : persistEffectResult(secretResult),
                onPersistFailed: uncertainEffectResult(name),
              });
            }
            const recordedForAsk = await recordEffect(deps, run, name, effectKey, args);
            const missingSecretAction = resolveMissingRunSecretAction(recordedForAsk.effect);
            if (missingSecretAction.action === "return") return missingSecretAction.result;
            if (connectionId) {
              const connectionStatus = await reconcileManagedConnection(
                deps.prisma,
                deps.connectors,
                run,
                context,
                connectionId,
              );
              if (connectionStatus === "connected") {
                const connectedResult = {
                  ok: true,
                  submitted: true,
                  connected: true,
                };
                if (recordedForAsk.effect.status === "executing") {
                  return (await completeExternalEffect(
                    deps.prisma,
                    recordedForAsk.effect.id,
                    "executing",
                    connectedResult,
                  ))
                    ? connectedResult
                    : uncertainEffectResult(name);
                }
                return (await persistEffectResult(connectedResult))
                  ? connectedResult
                  : uncertainEffectResult(name);
              }
            }
            if (missingSecretAction.action === "settle_attempt") {
              // Secret was taken and connector may have consumed the OTP; do not re-ask.
              const failedAttempt = {
                ok: true,
                submitted: true,
                connected: false,
                connectionError: "Connection could not be completed.",
              };
              if (recordedForAsk.effect.status === "executing") {
                return (await completeExternalEffect(
                  deps.prisma,
                  recordedForAsk.effect.id,
                  "executing",
                  failedAttempt,
                ))
                  ? failedAttempt
                  : uncertainEffectResult(name);
              }
              return settleUncertainEffect(deps.prisma, recordedForAsk.effect.id, "request_secret");
            }
            if (!(await renewRunLease(deps, runId, workerId, fence))) {
              return pauseForSecret();
            }
            await workspaceCheckpoint.flush();
            const paused = await deps.events.pauseRunForInput({
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              runId,
              attemptId: attempt.id,
              leaseOwner: workerId,
              leaseFence: fence,
              blocks: [
                {
                  kind: "ask",
                  text: String(args.label ?? "Code"),
                  input: "secret",
                  ...(destination ? { credential: destination } : {}),
                  purpose: normalizeSecretAskPurpose(
                    args.purpose ? String(args.purpose) : undefined,
                  ),
                  status: "pending",
                },
              ],
            });
            if (!paused) {
              throw new Error("Could not pause this run for protected input; try sending again.");
            }
            if (paused.continuationRunId) {
              await deps.jobs
                .enqueue(runContinueJob(paused.continuationRunId))
                .catch((error) => getLogger().error("steering continuation enqueue", error));
            }
            await notifyRun(deps, run, {
              kind: "help",
              title: `${displayName(bot.name, "Bot")} needs a code`,
              body: String(args.label ?? "Code"),
              botId: bot.id,
              threadId: thread.id,
            });
            return pauseForSecret();
          }
          if (name === "request_takeover") return { ok: true };
          if (name === "run_subagent") {
            return {
              ok: true,
              result: String(args.task ?? "done."),
            };
          }
          if (name === "propose_instructions_update") {
            if (nextApprovedTool !== name || !claimedEffect) {
              return finish({ error: "Instruction updates require human approval." });
            }
            const committed = await deps.prisma.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
              await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
              const live = await tx.run.findUnique({ where: { id: runId } });
              if (!mayOpenModelStream(live, workerId, fence, context.signal.aborted)) {
                throw new Error("Instruction update run is no longer active.");
              }
              let undoVersionId: string | null;
              try {
                undoVersionId = await writeBotInstructions(tx, {
                  botId: bot.id,
                  instructions: String(args.instructions),
                  reason: String(args.reason),
                  expectedInstructions: String(args.previousInstructions),
                  proposalRunId: runId,
                });
              } catch (error) {
                if (!(error instanceof InstructionConflictError)) throw error;
                await tx.bot.updateMany({
                  where: { id: bot.id, pendingInstructionsRunId: runId },
                  data: { pendingInstructionsRunId: null },
                });
                return { error: error.message };
              }
              if (!undoVersionId) return null;
              return persistMessageInTransaction(tx, run, "bot", [
                {
                  kind: "ask",
                  text: "Instructions updated",
                  status: "answered",
                  instructionUpdate: {
                    botId: bot.id,
                    before: redactSecrets(String(args.previousInstructions), runSecrets),
                    after: String(args.instructions),
                    reason: String(args.reason),
                    undoVersionId,
                  },
                },
              ]);
            });
            if (committed && "error" in committed) return finish(committed);
            if (committed)
              await deps.events
                .notify(run.threadId, committed.eventSeq)
                .catch((error) =>
                  getLogger().error("instruction update realtime notification", error),
                );
            return finish({ ok: true });
          }
          if (name === "spawn_bot") {
            const computerModeArg = args.computer_mode;
            let computerMode: "team" | "dedicated" | undefined;
            if (computerModeArg != null && computerModeArg !== "") {
              const value = String(computerModeArg);
              if (value !== "team" && value !== "dedicated") {
                return finish({
                  error: 'computer_mode must be "team" or "dedicated".',
                });
              }
              computerMode = value;
            }
            const spawned = await spawnBot(deps, {
              spawnedBy: {
                id: bot.id,
                name: bot.name,
                spaceId: bot.spaceId,
                userId: run.userId,
              },
              runId,
              spawnKey: effectKey,
              name: String(args.name ?? ""),
              title: args.title ? String(args.title) : undefined,
              description: args.description ? String(args.description) : undefined,
              instructions: args.instructions ? String(args.instructions) : undefined,
              prompt: args.prompt ? String(args.prompt) : undefined,
              computerMode,
            });
            if ("error" in spawned) return finish(spawned);
            if (!(await persistEffectResult(spawned))) return uncertainEffectResult(name);
            try {
              await publishMessage(deps, run, "bot", [
                {
                  kind: "child_bot",
                  botId: spawned.botId,
                  name: spawned.name,
                  title: spawned.title,
                  status: "created",
                },
              ]);
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                type: "bot.spawned",
                payload: { childBotId: spawned.botId, name: spawned.name },
              });
            } catch (error) {
              getLogger().error("spawned bot notification", error);
            }
            return spawned;
          }
          if (name === "list_fleet") return finish(await listFleet(deps, fleetRun, args));
          if (name === "organize_bot")
            return finish(await organizeBot({ ...deps, runSecrets }, fleetRun, args));
          // Replay hands these the canonical request stored with the approved effect.
          if (name === "create_group") return finish(await createFleetGroup(deps, fleetRun, args));
          if (name === "update_group") return finish(await updateFleetGroup(deps, fleetRun, args));
          if (name === "set_child_instructions") {
            return finish(await setChildInstructions(deps, fleetRun, args));
          }
          if (name === "set_child_bot_model") {
            const modelDeps = { ...fleetPrepareDeps(deps, run), events: deps.events };
            return finish(await setChildBotModel(modelDeps, fleetRun, args));
          }
          if (name === "create_child_routine") {
            return finish(await createChildRoutine(deps, fleetRun, args));
          }
          if (name === "update_bot" && argumentGiven(args.bot_id)) {
            return finish(await updateChildBot({ ...deps, runSecrets }, fleetRun, args));
          }
          if (name === "update_bot") {
            const parsed = parseUpdateBotPatch(args, bot.name);
            if ("error" in parsed) return finish(parsed);
            const patch = parsed.patch;
            const wantsImage = args.artifact_id !== undefined || args.use_attached_image === true;
            let sourceImageArtifactIds: string[] = [];
            if (wantsImage && run.sourceMessageId) {
              const source = await deps.prisma.message.findUnique({
                where: { id: run.sourceMessageId },
                select: { blocks: true, threadId: true },
              });
              if (source?.threadId === thread.id) {
                sourceImageArtifactIds = attachedImageArtifactIds(source.blocks as MessageBlock[]);
              }
            }
            const avatar = await resolveUpdateBotAvatar({
              color: args.color,
              artifactId: args.artifact_id,
              useAttachedImage: args.use_attached_image,
              sourceImageArtifactIds,
              loadArtifact: async (id) => {
                if (!deps.artifacts) return null;
                const row = await deps.prisma.artifact.findFirst({
                  where: { id, spaceId: run.spaceId, userId: run.userId },
                  select: { mimeType: true, storageKey: true },
                });
                if (!row || !isAttachmentImageMimeType(row.mimeType)) return null;
                try {
                  return await deps.artifacts.get(row.storageKey, context);
                } catch {
                  return null;
                }
              },
            });
            if ("error" in avatar && avatar.error !== "missing") {
              return finish({ error: avatar.error });
            }
            if ("color" in avatar) patch.color = avatar.color;
            if (Object.keys(patch).length === 0) {
              return finish({
                error:
                  "Provide at least one of name, title, description, notifyOnFinish, color, artifact_id, or use_attached_image.",
              });
            }
            const updated = await deps.prisma.bot.update({
              where: { id: bot.id },
              data: patch,
              select: {
                id: true,
                name: true,
                title: true,
                description: true,
                color: true,
                notifyOnFinish: true,
              },
            });
            try {
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                type: "bot.updated",
                payload: {
                  botId: updated.id,
                  name: updated.name,
                  title: updated.title,
                  description: updated.description,
                },
              });
            } catch (error) {
              getLogger().error("bot.updated notification", error);
            }
            return finish({
              ok: true,
              botId: updated.id,
              name: updated.name,
              title: updated.title,
              description: updated.description,
              avatar: updated.color.startsWith("data:image/") ? "image" : updated.color,
              notifyOnFinish: updated.notifyOnFinish,
            });
          }
          if (name === "message_user") {
            const rawMessage = redactSecrets(String(args.message ?? ""), runSecrets);
            const maxLength = messageUserMaxLength();
            const text = clampUserProgressMessage(rawMessage, maxLength);
            if (!text) return finish({ error: "message is required" });
            const truncated = isProgressMessageTruncated(rawMessage, maxLength);
            await flushProgress();
            await publishMidTurnNarration();
            if (!canPublishDurableProgress()) {
              return finish({
                ok: true,
                note: "This update was not posted. The turn is still fresh, or the chat already has enough interim messages for this run. Do not send more progress updates — keep working and put everything in your final reply.",
              });
            }
            await publishMessage(
              deps,
              run,
              "bot",
              [{ kind: "text", text }],
              true,
              userProgressClientNonce(run.id, midTurnProgressCount++),
            );
            midTurnUserTexts.push(text);
            publishedMidTurnUserMessage = true;
            return finish(
              truncated
                ? {
                    ok: true,
                    truncated: true,
                    note: `This progress update was cut off at ${maxLength} characters and the user only saw the truncated version above — it did NOT deliver your full content. message_user is for short interim beats only, never the final answer. Put your complete answer in your normal final reply instead of relying on this truncated update.`,
                  }
                : { ok: true },
            );
          }
          if (name === "message_bot") {
            const sent = await messageBot(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              {
                bot_id: args.bot_id ? String(args.bot_id) : undefined,
                confirm_name: args.confirm_name ? String(args.confirm_name) : undefined,
                message: redactSecrets(String(args.message ?? ""), runSecrets),
                intent: args.intent as
                  | "request"
                  | "result"
                  | "question"
                  | "status"
                  | "fyi"
                  | undefined,
                deliveryKey: effectKey,
              },
            );
            if (!sent.ok) return finish({ error: sent.error });
            return finish({
              ok: true,
              botId: sent.botId,
              name: sent.name,
              note: sent.note,
            });
          }
          if (name === "connect_agent") {
            const result = await connectAgent(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              { address: args.address ? String(args.address) : undefined },
            );
            if (!result.ok) return finish({ error: result.error });
            return finish(result);
          }
          if (name === "respond_agent_connection") {
            const result = await respondAgentConnection(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              { accept: Boolean(args.accept) },
            );
            if (!result.ok) return finish({ error: result.error });
            return finish(result);
          }
          if (name === "message_agent") {
            const result = await messageConnectedAgent(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              {
                address: args.address ? String(args.address) : undefined,
                message: redactSecrets(String(args.message ?? ""), runSecrets),
                deliveryKey: effectKey,
              },
            );
            if (!result.ok) return finish({ error: result.error });
            return finish(result);
          }
          if (name === "handoff_to_bot") {
            if (!thread.groupId)
              return finish({
                error: "handoff_to_bot is only for group chats",
              });
            const result = await handoffToGroupBot(deps, run, thread.groupId, {
              bot_id: args.bot_id ? String(args.bot_id) : undefined,
              confirm_name: args.confirm_name ? String(args.confirm_name) : undefined,
              message: String(args.message ?? ""),
            });
            if ("ok" in result && result.ok) handedOff = true;
            return finish(result);
          }
          if (name === "archive_bot" || name === "delete_bot") {
            const archived = await archiveSpawnedBot(
              deps,
              {
                spawnedByBotId: bot.id,
                userId: run.userId,
                spaceId: run.spaceId,
                confirmName: String(args.confirm_name ?? args.confirmName ?? ""),
                botId: args.bot_id
                  ? String(args.bot_id)
                  : args.botId
                    ? String(args.botId)
                    : undefined,
              },
              context,
            );
            if ("error" in archived) return finish(archived);
            if (!(await persistEffectResult(archived))) return uncertainEffectResult(name);
            try {
              await publishMessage(deps, run, "bot", [
                {
                  kind: "child_bot",
                  botId: archived.botId,
                  name: archived.name,
                  status: "archived",
                },
              ]);
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                type: "bot.archived",
                payload: { childBotId: archived.botId, name: archived.name },
              });
            } catch (error) {
              getLogger().error("archived bot notification", error);
            }
            return archived;
          }
          if (deps.connector) {
            let result: unknown = { error: `unknown tool ${name}` };
            for await (const event of deps.connector.execute(
              { ...connectorCall, tool: name, args, executionId: effectKey },
              context,
            )) {
              if (event.type === "result") {
                result = event.data;
                const logIds = collectLogIds(event.data);
                for (const logId of logIds) {
                  await deps.events.append({
                    spaceId: run.spaceId,
                    threadId: thread.id,
                    botId: bot.id,
                    runId: run.id,
                    type: "effect.recorded",
                    payload: { tool: name, logId },
                  });
                }
              }
              if (event.type === "error") {
                result = { error: event.message };
                for (const logId of event.logIds ?? []) {
                  await deps.events.append({
                    spaceId: run.spaceId,
                    threadId: thread.id,
                    botId: bot.id,
                    runId: run.id,
                    type: "effect.recorded",
                    payload: { tool: name, logId },
                  });
                }
              }
            }
            return finish(result);
          }
          return finish({ error: `unknown tool ${name}` });
        };

        // Runtimes may dispatch parallel calls; a run can open only one proposal at a time.
        let instructionProposalInFlight = false;
        const dispatchOneTool = async (...params: Parameters<typeof dispatchTool>) => {
          if (params[0] !== "propose_instructions_update") return dispatchTool(...params);
          if (instructionProposalInFlight)
            return { error: "This bot already has a pending instruction proposal." };
          instructionProposalInFlight = true;
          try {
            return await dispatchTool(...params);
          } finally {
            instructionProposalInFlight = false;
          }
        };
        const applyTool = async (...params: Parameters<typeof dispatchTool>) => {
          try {
            return await dispatchOneTool(...params);
          } finally {
            if (toolResultTaintsRun(params[0])) runTainted = true;
          }
        };

        const pluginLine =
          connectedPlugins.length > 0
            ? `Connected plugins: ${connectedPlugins.map((row) => `${row.displayName} (${row.connectorId}:${row.provider})`).join(", ")}. Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).`
            : "No plugins are connected yet.";
        const taughtSkillIndex = savedSkills.slice(0, 20);
        const taughtSkillsLine =
          taughtSkillIndex.length > 0
            ? `Saved taught skills:\n${taughtSkillIndex
                .map((skill) => {
                  const playbook = parsePlaybook(skill.playbook);
                  const name = skill.name || skill.goal.slice(0, 80);
                  return `- ${name}: ${playbook.whenToUse || skill.goal}`;
                })
                .join(
                  "\n",
                )}\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.`
            : undefined;
        const agentSkillsLine = formatSkillsCatalogInstruction(agentSkills);
        const missingImagesInstruction = missingTurnImagesInstruction(
          turnBlocks,
          currentTurnImages,
        );
        const taskPrompt = expandSkillReferencesInPrompt(
          [task.prompt, attachedFilesPrompt, missingImagesInstruction].filter(Boolean).join("\n\n"),
          agentSkills,
        );
        const invokedSkill = savedSkills.find((skill) =>
          promptInvokesSkill(taskPrompt, skill.name || skill.goal),
        );
        const basePrompt = invokedSkill
          ? `${formatSkillRunPrompt(
              invokedSkill.name || invokedSkill.goal.slice(0, 80),
              parsePlaybook(invokedSkill.playbook),
            )}\n\n${taskPrompt}`
          : taskPrompt;
        const approvalContinuation = buildApprovalContinuation(
          approvedEffects,
          (request) => redactSecrets(JSON.stringify(request), runSecrets),
          { exposedToolNames: new Set(tools.map((tool) => tool.name)) },
        );
        const replyContext = await loadReplyContext(deps.prisma, thread.id, run.sourceMessageId);
        let userTimeZone: string | null | undefined;
        try {
          userTimeZone = (
            await deps.prisma.user.findUnique({
              where: { id: run.userId },
              select: { timezone: true },
            })
          )?.timezone;
        } catch {
          // Timezone is optional context; a lookup failure must not prevent a run.
        }
        const prompt = [
          replyContext,
          run.trigger === "reaction" && replyContext ? undefined : basePrompt,
          takeoverResume?.promptNote,
          approvalContinuation,
          // A hang-up turn is read, not heard: no spoken-reply constraint.
          // Per-turn, not in the system prompt: the timestamp changes every call and would break the cacheable prefix.
          formatCurrentTimeInstruction(new Date(), userTimeZone),
        ]
          .filter(Boolean)
          .join("\n\n");
        const historicalContext: AgentRunRequest["history"] = [];
        if (compactedHistory.usedLocalSummary && compactedHistory.summary) {
          historicalContext.push({
            role: "user",
            content: redactSecrets(
              formatCompactedSummary(compactedHistory.summary, thread.historyCompactedUpToSeq!),
              runSecrets,
            ),
          });
        }
        const modelImageBudget =
          resolved.maxImagesPerPrompt === undefined
            ? undefined
            : Math.max(0, resolved.maxImagesPerPrompt - (currentTurnImages?.length ?? 0));
        // A text-only model keeps the [image:] marker. Putting image parts in
        // history makes the provider reject a follow-up that used to be text.
        const historyWithImages = modelSeesImages
          ? await withRecentTurnImages(deps, history, historyMessages, context, {
              skipMessageId: currentTurnMessage?.id,
              maxImages: modelImageBudget,
            })
          : history;
        const runtimeHistory = [...historicalContext, ...historyWithImages];
        // Without a roster a bot only knows the bots it spawned itself.
        const botDirectory = thread.groupId
          ? undefined
          : renderBotDirectory(
              (
                await deps.prisma.bot.findMany({
                  where: {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    archivedAt: null,
                    id: { not: bot.id },
                    thread: { isNot: null },
                  },
                  select: {
                    id: true,
                    name: true,
                    title: true,
                    description: true,
                  },
                  orderBy: { createdAt: "asc" },
                  take: BOT_DIRECTORY_LIMIT,
                })
              ).map((peer) => ({
                id: peer.id,
                name: peer.name,
                title: peer.title,
                description: peer.description,
              })),
            );

        if (heldForTakeover) {
          const releasedCheckpoint = takeoverCheckpointOf(
            (
              await deps.prisma.run.findUnique({
                where: { id: runId },
                select: { checkpoint: true },
              })
            )?.checkpoint,
          );
          if (releasedCheckpoint) {
            await requeueComputerRun(deps, runId, workerId, fence, releasedCheckpoint, false);
            return;
          }
        }

        // Stop during setup must not still open the model. A reclaimed lease can
        // leave status "running" under a new owner, and the stream loop only
        // notices cancellation after the provider request has started.
        const beforeModel = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true, leaseOwner: true, leaseFence: true },
        });
        if (
          !mayOpenModelStream(
            beforeModel,
            workerId,
            fence,
            !leaseValid || Boolean(runAbortController?.signal.aborted),
          )
        ) {
          return;
        }

        let fallbackModels: { provider: string; modelId: string }[] = [];
        if (!scripted) {
          try {
            fallbackModels = await deps.prisma.spaceBackupModel.findMany({
              where: { userId: run.userId, spaceId: run.spaceId },
              orderBy: { position: "asc" },
              select: { provider: true, modelId: true },
            });
          } catch (error) {
            getLogger().warn("Backup models could not be loaded", { runId, error });
          }
        }
        const fallbackModelKeys = new Set(
          fallbackModels
            .filter(
              (candidate) =>
                candidate.provider !== runModelProvider || candidate.modelId !== runModelId,
            )
            .map((candidate) => JSON.stringify([candidate.provider, candidate.modelId])),
        );

        try {
          const runtimeEvents = runtime.run(
            {
              botId: bot.id,
              threadId: thread.id,
              runId,
              routineId: run.routineId,
              sourceMessageId: run.sourceMessageId,
              onUsage: async (event) => {
                await recordUsage(deps.prisma, event, {
                  spaceId: run.spaceId,
                  botId: bot.id,
                  userId: run.userId,
                  runId,
                  parentRunId: runId,
                  operationId: runId,
                });
              },
              prompt,
              // Keep an explicit executor override, but let the runtime select
              // cache-aware context for connections declaring a cache window.
              contextStrategy: deps.contextStrategy,
              instructions: userTurnInstructions({
                botInstructions: runIdentityInstruction(bot, run.trigger),
                groupContext,
                messagingContext,
                redactedMemoryContext: memoryContext
                  ? redactSecrets(memoryContext, runSecrets)
                  : undefined,
                redactedScratchpadContext: scratchpadContext
                  ? redactSecrets(scratchpadContext, runSecrets)
                  : undefined,
                redactedTicketContext: ticketContext
                  ? redactSecrets(ticketContext, runSecrets)
                  : undefined,
                hasHistoricalContext: historicalContext.length > 0,
                historyRetrievalEnabled: contextStrategy !== "current",
                computerInstruction,
                pageBrowserAllowed: omp ? false : pageBrowserAllowed,
                taskCatalogInstruction,
                workspaceInstruction,
                agentEnvironmentInstruction: omp ? undefined : agentEnvironmentInstruction,
                botDirectory: omp ? undefined : botDirectory,
                pluginLine,
                agentSkillsLine,
                taughtSkillsLine,
                replyGuidance: runReplyGuidance(run.trigger),
                disabledBuiltinTools,
                offeredFleetTools: offeredFleetTools(builtins),
              })
                .filter((instruction): instruction is string => Boolean(instruction))
                .join("\n\n"),
              history: runtimeHistory,
              currentTurnImages,
              tools,
              model: {
                provider: runModelProvider,
                id: runModelId,
                apiKey: resolved.oauth ? undefined : resolved.apiKey,
                baseUrl: resolved.baseUrl,
                allowPrivateEndpoint: resolved.allowPrivateEndpoint,
                cacheCapabilities: resolved.cacheCapabilities,
                contextWindow: resolved.contextWindow,

                reasoning: resolved.reasoning,
                maxTokens: resolved.maxTokens,
                acceptsImages: resolved.acceptsImages,
                maxImagesPerPrompt: resolved.maxImagesPerPrompt,
                thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
                oauth: resolved.oauth
                  ? {
                      credential: resolved.oauth,
                      persist: resolved.persistOAuth,
                      retire: resolved.retireOAuth,
                    }
                  : undefined,
              },
              fallbackModels: fallbackModels.map(({ provider, modelId }) => ({
                provider,
                id: modelId,
              })),
              resolveFallbackModel: fallbackModelKeys.size
                ? async (provider, modelId) => {
                    const key = JSON.stringify([provider, modelId]);
                    if (!fallbackModelKeys.has(key))
                      throw new Error("Backup model is not selected");
                    return resolveConnectedModel(
                      { userId: run.userId, spaceId: run.spaceId },
                      provider,
                      modelId,
                      (values) => runSecrets.push(...values),
                      true,
                    );
                  }
                : undefined,
              onModelChange: async (provider, modelId) => {
                if (!fallbackModelKeys.has(JSON.stringify([provider, modelId]))) {
                  throw new Error("Backup model is not selected");
                }
                const updated = await deps.prisma.run.updateMany({
                  where: {
                    id: runId,
                    status: "running",
                    leaseOwner: workerId,
                    leaseFence: fence,
                  },
                  data: { modelProvider: provider, modelId },
                });
                if (updated.count !== 1) {
                  throw new Error("Run lease was lost before the backup model could be used");
                }
              },
              resumeFromCheckpoint: takeoverResume?.checkpoint,
              script,
              allowSilentEmpty: allowSilentEmptyRun,
              emptyResponseText,
              executeTool: scripted ? undefined : applyTool,
              resolveModel: scripted
                ? undefined
                : (provider, modelId) =>
                    resolveConnectedModel(run, provider, modelId, (values) =>
                      runSecrets.push(...values),
                    ),
              onToolCompleted: (completion) =>
                appendToolCompletionAudit(
                  deps,
                  {
                    spaceId: run.spaceId,
                    threadId: thread.id,
                    botId: bot.id,
                    runId,
                  },
                  completion,
                  runSecrets,
                ),
              claimSteering: scripted
                ? undefined
                : async (seenIds) => {
                    const steering = await deps.events.claimSteering({
                      threadId: thread.id,
                      botId: bot.id,
                      runId,
                      leaseOwner: workerId,
                      leaseFence: fence,
                      seenIds,
                    });
                    return Promise.all(
                      steering.map(async (item) => {
                        const { images, files, unavailableInstruction } =
                          await settleSteeringAttachmentLoads(
                            loadCurrentTurnImages(deps, item.blocks, context),
                            deps.artifacts
                              ? listCurrentTurnFiles(deps, item.blocks, context)
                              : Promise.resolve([]),
                            item.blocks,
                            context.signal,
                          );
                        if (files.length) pendingTurnFiles.push(item.blocks);
                        const filesInstruction = currentTurnFilesInstruction(files);
                        return {
                          id: item.id,
                          messageId: item.messageId,
                          historyText: item.text,
                          text: [
                            await loadReplyContext(deps.prisma, thread.id, item.messageId),
                            item.text,
                            filesInstruction,
                            unavailableInstruction,
                          ]
                            .filter(Boolean)
                            .join("\n\n"),
                          images,
                        };
                      }),
                    );
                  },
            },
            context,
          );
          for await (const event of withRuntimeCleanup(runtimeEvents, runAbortController)) {
            if (approvalPausePending) return;
            if (!leaseValid) return;
            const now = Date.now();
            if (now - lastLeaseCheckAt >= 1_000) {
              lastLeaseCheckAt = now;
              const still = await deps.prisma.run.findUnique({
                where: { id: runId },
                select: { status: true, leaseOwner: true, leaseFence: true, checkpoint: true },
              });
              if (
                !still ||
                still.status === "cancelled" ||
                still.leaseOwner !== workerId ||
                still.leaseFence !== fence
              ) {
                leaseValid = false;
                return;
              }
              const releasedHold = takeoverCheckpointOf(still.checkpoint);
              if (heldForTakeover && releasedHold) {
                await requeueComputerRun(deps, runId, workerId, fence, releasedHold, false);
                leaseValid = false;
                runAbortController?.abort();
                return;
              }
            }

            // Check complete assistant turns so split sentinel chunks are recognized
            // without treating a partial identifier (NO_RESPONSE_POLICY) as silence.
            if (event.type === "tool" || event.type === "takeover") {
              recordExplicitNoResponse(assistantTurnText);
              assistantTurnText = "";
            }
            if (event.type === "text") {
              assistantTurnText += event.text;
              if (assistantTurnBreakPending && event.text) {
                assistantTurnBreakPending = false;
                const separator = assistantTurnSeparator(assembled, event.text);
                if (separator) {
                  assembled += separator;
                  currentTextSegment += separator;
                  pendingProgress += progressRedactor.push(separator);
                }
              }
              assembled += event.text;
              currentTextSegment += event.text;
              toolCallStreak = { key: undefined, count: 0 };
              tryFlushPendingTools();
              pendingProgress += progressRedactor.push(event.text);
              const now = Date.now();
              if (!scripted && pendingProgress && now - lastProgressAt >= 250) {
                await flushProgress();
              }
            } else if (event.type === "turn") {
              assistantTurnBreakPending = true;
            } else if (event.type === "progress") {
              toolCallStreak = { key: undefined, count: 0 };
              if (run.trigger === "routine" || isBackgroundRunTrigger(run.trigger)) continue;
              // Flush batched text deltas first so an activity line cannot land
              // ahead of text the model streamed before the tool call.
              if (pendingProgress) {
                await deps.events.append({
                  spaceId: run.spaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  type: "thread.progress",
                  runId,
                  payload: { delta: pendingProgress, streaming: true },
                });
                pendingProgress = "";
                lastProgressAt = Date.now();
              }
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.progress",
                runId,
                payload: {
                  text: redactSecrets(event.text, runSecrets),
                  ...(event.activity ? { activity: true } : {}),
                },
              });
            } else if (event.type === "ask") {
              if (!(await renewRunLease(deps, runId, workerId, fence))) return;
              const safeText = redactSecrets(event.text, runSecrets);
              const safeDetail = event.detail
                ? redactSecrets(event.detail, runSecrets)
                : event.detail;
              const safeActions = event.actions?.map((action) => ({
                id: action.id,
                label: redactSecrets(action.label, runSecrets),
              }));
              await workspaceCheckpoint.flush();
              const paused = await deps.events.pauseRunForInput({
                spaceId: run.spaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId,
                attemptId: attempt.id,
                leaseOwner: workerId,
                leaseFence: fence,
                blocks: [
                  {
                    kind: "ask",
                    text: safeText,
                    detail: safeDetail,
                    status: "pending",
                    actions: safeActions,
                  },
                ],
                // Keep unredacted labels on the run for resume; message blocks stay redacted.
                offeredActions: event.actions,
              });
              if (!paused) return;
              if (paused.continuationRunId) {
                await deps.jobs
                  .enqueue(runContinueJob(paused.continuationRunId))
                  .catch((error) => getLogger().error("steering continuation enqueue", error));
              }
              await notifyRun(deps, run, {
                kind: "help",
                title: `${displayName(bot.name, "Bot")} needs an answer`,
                body: safeText,
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "takeover") {
              if (!(await renewRunLease(deps, runId, workerId, fence))) return;
              // The user takes over the computer's screen, so it must be up before the run waits.
              await getRunComputer("takeover");
              const safeReason = redactSecrets(event.reason, runSecrets);
              // Publish pending narration as tagged mid-turn progress so reconciliation
              // does not treat pre-takeover text as the delegated final result.
              await publishMidTurnNarration();
              if (assembled.trim()) {
                const narration = clampUserProgressMessage(redactSecrets(assembled, runSecrets));
                if (narration && canPublishDurableNarration()) {
                  await publishMessage(
                    deps,
                    run,
                    "bot",
                    [{ kind: "text", text: narration }],
                    undefined,
                    userProgressClientNonce(run.id, midTurnProgressCount++),
                  );
                  midTurnUserTexts.push(narration);
                  publishedMidTurnUserMessage = true;
                } else if (narration) {
                  discardedMidTurnNarration = true;
                  lastDiscardedMidTurnNarration = narration;
                }
                assembled = "";
                hasStreamedText = false;
                pendingProgress = "";
              }
              await publishMessage(
                deps,
                run,
                "bot",
                [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: safeReason }],
                true,
              );
              await workspaceCheckpoint.flush();
              if (!(await holdComputerExecutionLeaseForTakeover(deps.prisma, computerLease))) {
                throw new Error("Computer lease expired before takeover");
              }
              const paused = await deps.events.pauseRunForTakeover({
                spaceId: run.spaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId,
                attemptId: attempt.id,
                leaseOwner: workerId,
                leaseFence: fence,
                reason: safeReason,
                computerId: storedComputer.id,
              });
              if (!paused) return;
              retainComputerLease = true;
              await notifyRun(deps, run, {
                kind: "takeover",
                title: `${displayName(bot.name, "Bot")} needs you on the screen`,
                body: safeReason,
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "tool") {
              // Preserve event ordering when the throttle still holds recent narration: the
              // client must see that text before the tool call it describes.
              await flushProgress();
              // Promote streamed narration into a durable, replyable chat message before
              // tools continue, so long turns do not look stalled and stay replyable.
              if (event.name !== "message_user") {
                await publishMidTurnNarration();
              }
              assistantTurnBreakPending = true;
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "agent.tool.called",
                runId,
                payload: { name: event.name, executionId: event.executionId },
              });
              pendingToolNames.push(event.name);
              tryFlushPendingTools();
              const loopGuard = advanceToolCallLoopGuard(toolCallStreak, event.name, event.args);
              toolCallStreak = loopGuard.streak;
              if (loopGuard.stuck) {
                approvedEffectReplays.assertDrained();
                flushPendingTools();
                if (!(await renewRunLease(deps, runId, workerId, fence))) return;
                if (messageSegments.length > 0) {
                  await publishMessage(deps, run, "bot", redactBlocks(messageSegments, runSecrets));
                }
                await workspaceCheckpoint.flush();
                terminalCheckpointComplete = true;
                const stuckText = loopGuardStopText(
                  humanizeToolName(event.name),
                  toolCallStreak.count,
                );
                const stopped = await deps.events.finalizeRun({
                  spaceId: run.spaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  runId,
                  taskId: run.taskId,
                  attemptId: attempt.id,
                  leaseOwner: workerId,
                  leaseFence: fence,
                  outcome: "completed",
                  blocks: isBackgroundRunTrigger(run.trigger)
                    ? []
                    : [{ kind: "text", text: stuckText }],
                });
                if (!stopped) return;
                stopHeartbeatAfterCompletion();
                if (stopped.continuationRunId) {
                  await deps.jobs
                    .enqueue(runContinueJob(stopped.continuationRunId))
                    .catch((error) => getLogger().error("steering continuation enqueue", error));
                }
                if (run.trigger === "bot_message") {
                  await returnBotMessageOutcome(
                    deps,
                    { ...run, sourceMessageId: run.sourceMessageId },
                    { id: bot.id, name: bot.name },
                    stuckText,
                    "result",
                    { forceUnread: true },
                  ).catch((error) => getLogger().error("bot message loop-guard return", error));
                }
                runAbortController?.abort();
                return;
              }
              if (scripted) {
                const startedAt = Date.now();
                try {
                  const result = await applyTool(event.name, event.args, event.executionId);
                  await appendToolCompletionAudit(
                    deps,
                    {
                      spaceId: run.spaceId,
                      threadId: thread.id,
                      botId: bot.id,
                      runId,
                    },
                    toolCompletionFromResult(
                      {
                        name: event.name,
                        executionId: event.executionId,
                        durationMs: Date.now() - startedAt,
                      },
                      result,
                    ),
                    runSecrets,
                  );
                  if (isToolPauseResult(result)) return;
                } catch (error) {
                  await appendToolCompletionAudit(
                    deps,
                    {
                      spaceId: run.spaceId,
                      threadId: thread.id,
                      botId: bot.id,
                      runId,
                    },
                    {
                      name: event.name,
                      executionId: event.executionId,
                      durationMs: Date.now() - startedAt,
                      error,
                    },
                    runSecrets,
                  );
                  throw error;
                }
              }
            } else if (event.type === "subagent") {
              const safeTask = redactSecrets(event.task, runSecrets);
              const safeProgress = event.progress
                ? redactSecrets(event.progress, runSecrets)
                : undefined;
              const safeResult = event.result ? redactSecrets(event.result, runSecrets) : undefined;
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.subagent",
                runId,
                payload: {
                  agentId: event.agentId,
                  name: event.name,
                  task: safeTask,
                  status: event.status,
                  progress: safeProgress,
                  result: safeResult,
                },
              });
              if (event.status === "completed" || event.status === "failed") {
                publishedTerminalSubagent ||= !subagentMarksUnread(
                  run.trigger,
                  event.status,
                  peerMessage?.repliesToRequest === true,
                );
                await publishMessage(
                  deps,
                  run,
                  "bot",
                  [
                    {
                      kind: "subagent",
                      agentId: event.agentId,
                      name: event.name,
                      task: safeTask,
                      status: event.status,
                      progress: safeProgress,
                      result: safeResult,
                    },
                  ],
                  subagentMarksUnread(
                    run.trigger,
                    event.status,
                    peerMessage?.repliesToRequest === true,
                  ),
                );
              }
            } else if (event.type === "usage" && !event.accounted) {
              await recordUsage(deps.prisma, event, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                runId,
                parentRunId: runId,
                operationId: runId,
              });
            } else if (event.type === "done") {
              recordExplicitNoResponse(event.text ?? "");
              if (!assembled && event.text) {
                if (publishedMidTurnUserMessage || discardedMidTurnNarration) {
                  // Mid-turn narration was already published or discarded (routines).
                  // Post-tool finals are streamed into assembled; do not restore
                  // cumulative done.text (clamp/redaction make substring stripping brittle).
                } else {
                  assembled = event.text;
                  currentTextSegment += event.text;
                }
              }
            }
          }

          recordExplicitNoResponse(assistantTurnText);
          runComputer.throwIfFailed();
          if (approvalPausePending || !leaseValid) return;
          approvedEffectReplays.assertDrained();
          pendingProgress += progressRedactor.finish();
          await flushProgress();

          for (const turn of script ?? []) {
            for (const file of turn.files ?? []) {
              workspaceCheckpoint.markDirty();
              await deps.sandbox.writeFile(
                await getRunComputer("script"),
                {
                  path: resolveBotWorkspacePath(computerMode, bot.id, file.path),
                  content: new TextEncoder().encode(file.content),
                },
                context,
              );
            }
            for (const mem of turn.memory ?? []) {
              await deps.memory.commit(
                {
                  scope: mem.scope,
                  botId: mem.scope === "bot" ? bot.id : undefined,
                  path: mem.path,
                  content: mem.content,
                  sourceRunId: runId,
                  sourceThreadId: thread.id,
                },
                context,
              );
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "memory.revised",
                runId,
                payload: { path: mem.path, scope: mem.scope },
              });
            }
          }

          await workspaceCheckpoint.flush();
          terminalCheckpointComplete = true;

          // Preserve the last held-back preview as a normal final reply when the
          // model supplies none, unless it chose silence or already delivered that text.
          // Persisting peer results here also lets outcome delivery retry after completion.
          recordExplicitNoResponse(lastDiscardedMidTurnNarration);
          if (
            !isBackgroundRunTrigger(run.trigger) &&
            !handedOff &&
            !explicitNoResponse &&
            !assembled.trim() &&
            lastDiscardedMidTurnNarration &&
            !midTurnUserTexts.includes(lastDiscardedMidTurnNarration)
          ) {
            assembled = lastDiscardedMidTurnNarration;
            currentTextSegment = assembled;
          }
          flushPendingTools();
          // Silent-allowed runs can choose an explicit NO_RESPONSE or finish empty.
          // Other runs still drop a stray sentinel at the edges of a real reply.
          const silentReply = allowSilentEmptyRun
            ? stripNoResponseReply(assembled, messageSegments)
            : stripStrayNoResponse(assembled, messageSegments);
          let completionBlocks = silentReply.blocks;
          if (!silentReply.assembled || isBackgroundRunTrigger(run.trigger)) {
            // Mid-turn progress already posted durable chat messages; skip the empty
            // "…" fallback so we do not add a junk final bubble. Delegated bot_message
            // runs still return via botMessageOutcomeFromMidTurn below (status when
            // only progress was posted, result when a final reply exists). Exact
            // NO_RESPONSE finals are treated as empty before this fallback runs.
            completionBlocks = completionMessageSegments(completionBlocks, {
              allowSilentEmpty: allowSilentEmptyRun || publishedMidTurnUserMessage,
              emptyResponseText,
              suppressOutput: handedOff || isBackgroundRunTrigger(run.trigger),
              skipEmptyFallback: publishedTerminalSubagent || publishedMidTurnUserMessage,
            });
          }
          const blocks = handedOff
            ? []
            : finalBlocksAfterMidTurnProgress(
                redactBlocks(completionBlocks, runSecrets),
                publishedMidTurnUserMessage || runAllowsSilentEmpty(run.trigger),
              );
          const text = handedOff
            ? ""
            : redactSecrets(completionNotificationBody(silentReply.assembled, blocks), runSecrets);
          if (containsSecret(text, runSecrets)) {
            throw new Error("refusing to persist a secret in the thread");
          }
          // Tool steps succeeded and the only completion text is the synthetic
          // empty notice. That is a missed final answer or a swallowed provider
          // failure, not a successful delegated summary.
          if (
            !handedOff &&
            !silentReply.assembled.trim() &&
            emptyDelegatedToolTurnShouldFail(completionBlocks)
          ) {
            throw new Error(TOOL_STEPS_WITHOUT_RESPONSE);
          }
          if (!(await renewRunLease(deps, runId, workerId, fence))) return;
          const botMessageOutcome =
            run.trigger === "bot_message"
              ? botMessageOutcomeFromMidTurn(text, midTurnUserTexts)
              : null;
          const completed = await deps.events.finalizeRun({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId,
            taskId: run.taskId,
            attemptId: attempt.id,
            leaseOwner: workerId,
            leaseFence: fence,
            outcome: "completed",
            blocks,
            markUnread: completionMarksUnread(
              run.trigger,
              text,
              peerMessage?.repliesToRequest === true,
            ),
          });
          if (!completed) return;
          stopHeartbeatAfterCompletion();
          if (screenRelease) screenRelease.keepWarm = true;
          if (completed.continuationRunId) {
            await deps.jobs
              .enqueue(runContinueJob(completed.continuationRunId))
              .catch((error) => getLogger().error("steering continuation enqueue", error));
          }
          if (botMessageOutcome) {
            // Prefer the final reply. If the turn only posted mid-turn progress, return that
            // text explicitly as status. Delivery uses a stable auto-outcome key; mark
            // botOutcomeReturnedAt only after a successful (or intentionally skipped) return
            // so a crash or failed delivery stays visible to the reconciler.
            await returnBotMessageOutcome(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              botMessageOutcome.text,
              botMessageOutcome.intent,
            ).catch((error) => getLogger().error("bot message result return", error));
          }
          const notifyBody = completionNotificationPreview(text);
          if (
            runSendsFinishNotification(run.trigger) &&
            notifyBody &&
            !completed.continuationRunId
          ) {
            await notifyRun(deps, run, {
              kind: "completion",
              title: `${displayName(bot.name, "Bot")} finished`,
              body: notifyBody,
              botId: bot.id,
              threadId: thread.id,
            });
          }
          // Last, and never fatal: the run is already finalized, so a failure here must not reach
          // the catch block below, where a second finalizeRun would match no rows and silently
          // skip the completion notification.
          try {
            const updatedThread = await deps.prisma.thread.findUniqueOrThrow({
              where: { id: thread.id },
              select: {
                nextMessageSeq: true,
                historyCompactedUpToSeq: true,
              },
            });
            if (
              contextStrategy === "current" &&
              shouldEnqueueCompaction(
                updatedThread.nextMessageSeq,
                updatedThread.historyCompactedUpToSeq,
                HISTORY_WINDOW_SIZE,
                COMPACTION_BATCH_SIZE,
              )
            ) {
              await deps.jobs.enqueue(historyCompactJob(thread.id));
            }
          } catch (error) {
            getLogger().error("history.compact enqueue failed", error);
          }
        } catch (caughtError) {
          let error = caughtError;
          // A refused account limit needs user/operator action, not setup-job retries.
          // Keep the provisioning error even if aborting the model masked it.
          try {
            runComputer.throwIfFailed();
          } catch (computerError) {
            if (!(computerError instanceof SandboxRateLimitError)) throw computerError;
            error = computerError;
          }
          if (!terminalCheckpointComplete) {
            await workspaceCheckpoint.flush().catch(() => undefined);
          }
          const message = redactSecrets(
            error instanceof Error ? error.message : String(error),
            runSecrets,
          );
          const failed = await deps.events.finalizeRun({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId,
            taskId: run.taskId,
            attemptId: attempt.id,
            leaseOwner: workerId,
            leaseFence: fence,
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
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              `Could not complete the delegated request: ${message}`,
              "status",
              { forceUnread: true },
            ).catch((returnError) => getLogger().error("bot message failure return", returnError));
          }
          const retrying =
            !failed.continuationRunId && (await scheduleRoutineRetry(deps, run, error));
          if (runSendsFinishNotification(run.trigger) && !failed.continuationRunId && !retrying) {
            await notifyRun(deps, run, {
              kind: "failure",
              title: `${displayName(bot.name, "Bot")} failed`,
              body: message,
              botId: bot.id,
              threadId: thread.id,
            });
          }
        }
      } catch (setupError) {
        const computerBusy = setupError instanceof ComputerBusyError;
        const retryForever = computerBusy || isTooManyDatabaseConnections(setupError);
        const setupMessage = redactSecrets(
          setupError instanceof Error ? setupError.message : String(setupError),
          runSecrets,
        );
        if (!computerBusy) {
          // undici collapses every network failure to "fetch failed"; the cause names the
          // host and errno, which is the only part worth paging over.
          const causeMessage =
            setupError instanceof Error && setupError.cause instanceof Error
              ? `: ${redactSecrets(setupError.cause.message, runSecrets)}`
              : "";
          getLogger().error("run setup failed", `${setupMessage}${causeMessage}`);
        }
        // The job reconciler re-enqueues a queued run whose job ran out of attempts, so a
        // setup that fails every time would retry forever. End the run instead.
        if (
          !retryForever &&
          (await setupFailureStreak(deps.prisma, runId)) >= RUN_SETUP_FAILURE_LIMIT - 1
        ) {
          const bot = await deps.prisma.bot.findUnique({
            where: { id: run.botId },
            select: { name: true },
          });
          await failRunBeforeTurn(
            deps,
            run,
            bot?.name ?? "",
            { attemptId: attempt.id, workerId, fence },
            setupMessage,
          );
          return;
        }
        const released = await writeComputerRunRequeue(
          deps,
          runId,
          workerId,
          fence,
          resumeCheckpoint,
          heldForTakeover,
          retryForever ? null : "Run setup failed; retrying",
        );
        if (released) {
          await deps.prisma.attempt.update({
            where: { id: attempt.id },
            data: {
              status: "setup_failed",
              error: retryForever ? null : "Run setup failed; retrying",
              finishedAt: new Date(),
            },
          });
          if (retryForever) {
            await deps.jobs.enqueue({
              ...runContinueJob(runId),
              availableAt: new Date(Date.now() + computerRetryDelay(fence)),
            });
            return;
          }
          throw new Error("Run setup failed; retrying");
        }
      } finally {
        getLogger().info("run.computer", {
          "run.id": runId,
          trigger: run.trigger,
          reason: computerUseReason,
          tool: computerUseTool,
          ready: Boolean(screenRelease),
        });
        detachShutdown?.();
        clearInterval(heartbeat);
        if (!retainComputerLease) {
          if (screenRelease) {
            const releaseContext = screenRelease.keepWarm
              ? { ...screenRelease.context, keepScreenWarm: true }
              : screenRelease.context;
            await deps.sandbox
              .releaseScreen?.(screenRelease.computer, releaseContext)
              .catch(() => undefined);
          }
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
        }
        await deps.prisma.attempt
          .updateMany({
            where: { id: attempt.id, status: "running" },
            data: { status: "interrupted", finishedAt: new Date() },
          })
          .catch(() => undefined);
      }
    },
  };
}
