import { implement, ORPCError } from "@orpc/server";
import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  MemoryStore,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { computerControlExpireJobKey } from "@rakazo/adapter-kit";
import type {
  CloudAgentConnection,
  CodexLiveCatalog,
  ConnectorRegistry,
  FaviconResolver,
  McpConnector,
  McpOAuthSummary,
  PiOAuthLogins,
  ProviderCatalogCache,
  RemoteConnectorDependencies,
  TicketChangeNotifier,
} from "@rakazo/adapters";
import {
  applyCodexLiveCatalog,
  applyProviderLiveCatalog,
  CHATGPT_OAUTH_PROVIDER,
  CodexCatalogCache,
  clearInactiveUserComputerControl,
  codexLiveCatalogsForSpace,
  createFaviconResolver,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  hostCredentialSource,
  kickModelCredentialRefresh,
  listAvailablePiCatalog,
  McpOAuthBroker,
  modelCredentialAuthKindsForSpace,
  parseRoutineWatch,
  parseRoutineWatchState,
  providerCatalogCache,
  providerLiveCatalogsForSpace,
  recordMcpServerHealth,
  revokeScreenControl,
  savedCatalogSelections,
  scheduleComputerSleep,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { Actor, ComputerReleaseReason, Me, Routine } from "@rakazo/contracts";
import {
  appContract,
  attachmentMaxBytes,
  canonicalPiProviderId,
  mcpOAuthEnvReferences,
} from "@rakazo/contracts";
import type {
  BoardEvents,
  McpServer as McpServerRow,
  PrismaClient,
  ThreadEvents,
} from "@rakazo/db";
import {
  createGroupRepos,
  createRepos,
  findDefaultModelCredential,
  IsolationError,
  runAsTenant,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createAgentSkillsService } from "../agent-skills.js";
import type { McpSecretMaterial } from "../mcp-material.js";
import { createTaughtSkillsService } from "../taught-skills.js";
import type { WorkflowPackageInstaller, WorkflowPackageRemoval } from "../workflows.js";
import { createWorkflowsService } from "../workflows.js";

export const THREAD_MESSAGE_PAGE_SIZE = 100;

/** Silence longer than this on a thread stream is indistinguishable from a dead socket. */
export const HEARTBEAT_MS = 20_000;

/** A thread stream re-checks its session at least this often while it delivers. */
export const SESSION_RECHECK_MS = 10_000;

export function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

export const MCP_OAUTH_PENDING_MESSAGE = "Connect this server's account to check it.";

/** Loopback / LAN / Docker-network endpoints: the deployment owner, or everyone under the flag. */
export function mayUsePrivateEndpoint(actor: Actor, deps: Pick<RouterDeps, "env">): boolean {
  return actor.isDeploymentOwner || deps.env.mcpAllowPrivateEndpoint === true;
}

export interface RouterDeps {
  cloudAgent?: CloudAgentConnection | null;
  prisma: PrismaClient;
  events: ThreadEvents;
  boardEvents: BoardEvents;
  ticketChanges: TicketChangeNotifier;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  home: AgentHomeStore;
  secrets: SecretStore;
  oauthLogins: PiOAuthLogins;
  /** Live Codex catalog seam; defaults to the shared per-process cache. */
  codexCatalog?: CodexLiveCatalog;
  providerCatalog?: ProviderCatalogCache;
  /** Site icons for links; defaults to the per-process cache that fetches them. */
  favicons?: FaviconResolver;
  /**
   * Detached refresh for a stored credential whose bearer expired — the live
   * catalog path calls it instead of refreshing inline. Defaults to the
   * runtime's locked `kickModelCredentialRefresh`; injectable for tests so a
   * catalog read never reaches the real OAuth refresh endpoint.
   */
  refreshExpiredModelCredential?: (
    scope: { userId: string; spaceId: string },
    secretId: string,
    provider: string,
  ) => void;
  mcpOAuth?: McpOAuthBroker;
  /**
   * The API process's MCP connector, used to launch/list an MCP server once so its health
   * is visible (`mcp.servers.test` and the probe after create/update/OAuth). Without it
   * servers are simply never probed from here.
   */
  mcp?: Pick<McpConnector, "probe">;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  artifacts: ArtifactStore;
  dataDir: string;
  workflowInstaller?: WorkflowPackageInstaller;
  workflowRemover?: WorkflowPackageRemoval;
  workflowRunsCancelled?: (actor: Actor, runIds: string[]) => Promise<void>;
  /** Present when the external messaging surface is enabled. */
  messaging?: { enabled: boolean; providers: string[] };
  env: {
    ticketBoardEnabled?: boolean;
    maxUploadSizeBytes?: number;
    agentRuntime: string;
    externalConversationJudgeProvider?: string;
    externalConversationJudgeModel?: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelConfigured?: boolean;
    deploymentModelHostCredentials?: boolean;
    webOrigin: string;
    screenProxySecret: string;
    sandboxProvider: string;
    gitSha?: string;
    integrationsCatalogUrl?: string;
    mcpAllowPrivateEndpoint?: boolean;
  };
}

/**
 * Runs an authenticated procedure with row-level security scoped to the actor's
 * Space. A streamed result is read after the procedure returns, so each step of
 * its iterator re-enters the same scope.
 */
export async function asTenant<T extends { output: unknown }>(
  actor: Actor,
  next: () => T | PromiseLike<T>,
): Promise<T> {
  const result = await runAsTenant(actor, next);
  const output = result.output;
  if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return result;
  const iterator = output as AsyncIterator<unknown> & AsyncIterable<unknown>;
  const scoped: AsyncIterableIterator<unknown> = {
    next: (...args) => runAsTenant(actor, () => iterator.next(...args)),
    return: (value) =>
      runAsTenant(actor, () => iterator.return?.(value) ?? { done: true as const, value }),
    throw: (error) =>
      runAsTenant(actor, () => (iterator.throw ? iterator.throw(error) : Promise.reject(error))),
    [Symbol.asyncIterator]() {
      return scoped;
    },
  };
  return { ...result, output: scoped };
}

export function hostCredentials(active: boolean, provider: string) {
  return active
    ? { hostCredentialProvider: provider, hostCredentialSource: hostCredentialSource(provider) }
    : { hostCredentialProvider: null, hostCredentialSource: null };
}

export async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
    modelSetup(deps, actor),
  ]);
  return {
    ticketBoardEnabled: deps.env.ticketBoardEnabled === true,
    maxUploadSizeBytes: attachmentMaxBytes(deps.env),
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: actor.isDeploymentOwner,
    needsModel: setup.needsModel,
    defaultProvider: canonicalPiProviderId(
      setup.credential?.provider ??
        setup.settings?.defaultModelProvider ??
        deps.env.defaultProvider,
    ),
    defaultModel:
      setup.credential?.defaultModel ?? setup.settings?.defaultModelId ?? deps.env.defaultModel,
    // Set only while the active default is the deployment's own, running on host credentials.
    ...hostCredentials(
      !setup.credential &&
        !setup.settings?.defaultModelProvider &&
        Boolean(deps.env.deploymentModelHostCredentials),
      deps.env.defaultProvider,
    ),
    sandboxProvider: deps.env.sandboxProvider,
    avatarStyle: user.avatarStyle === "robot" ? "robot" : "organic",
    timezone: user.timezone ?? null,
  };
}

export async function modelSetup(deps: RouterDeps, actor: Actor) {
  const [credential, settings] = await Promise.all([
    findDefaultModelCredential(deps.prisma, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const hasDeployment = Boolean(deps.env.deploymentModelConfigured);
  return {
    credential,
    settings,
    needsModel: deps.env.agentRuntime !== "scripted" && !credential && !hasDeployment,
  };
}

/** Hand the user's screen control for this bot back, continuing any run waiting on it. */
export async function releaseComputerControl(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
  reason?: ComputerReleaseReason,
  expectedRunId?: string,
): Promise<void> {
  let bot = await createRepos(deps.prisma).getBot(actor, botId);
  if (!bot.computer) {
    if (expectedRunId !== undefined) return;
    throw new IsolationError();
  }
  const unopenedTakeover =
    expectedRunId !== undefined &&
    bot.computer.controlHolder === "none" &&
    bot.computer.controlBotId === null &&
    bot.computer.controlLeaseId === null &&
    bot.computer.controlRunId === expectedRunId;
  if (unopenedTakeover) {
    const released = await deps.events.finalizeComputerControlRelease({
      spaceId: actor.spaceId,
      computerId: bot.computer.id,
      botId: bot.id,
      runId: expectedRunId,
      leaseId: null,
      holder: "bot",
      reason: reason ?? "released",
    });
    if (released) {
      await enqueueTakeoverContinuation(deps.jobs, released.runId);
      scheduleComputerSleep(deps.jobs, bot.computer.id);
      return;
    }
    bot = await createRepos(deps.prisma).getBot(actor, botId);
    if (!bot.computer) return;
  }
  const controlBotId = bot.computer.controlBotId;
  const controlLeaseId = bot.computer.controlLeaseId;
  if (bot.computer.controlHolder !== "user" || !controlBotId || controlBotId !== bot.id) return;
  if (expectedRunId !== undefined && bot.computer.controlRunId !== expectedRunId) return;
  if (!hasActiveComputerControl(bot.computer) || !controlLeaseId) {
    // Stale controlHolder=user. Prefer expiry (revokes provider control). If a lease id
    // remains after a failed revoke, keep it so reconciliation can retry.
    if (controlLeaseId) {
      await expireComputerControl(deps, bot.computer.id, controlLeaseId).catch(() => undefined);
    } else {
      await clearInactiveUserComputerControl(deps.prisma, bot.computer.id);
    }
    return;
  }
  await revokeScreenControl(
    deps,
    bot.computer,
    computerContext(actor, controlBotId, "screen.release"),
    controlLeaseId,
  );

  const released = await deps.events.finalizeComputerControlRelease({
    spaceId: actor.spaceId,
    computerId: bot.computer.id,
    botId: controlBotId,
    runId: bot.computer.controlRunId,
    leaseId: controlLeaseId,
    holder: "bot",
    reason: reason ?? "released",
  });
  if (!released) return;
  // The lease-specific key makes this cancellation safe after a replacement takeover.
  await deps.jobs
    .cancel(computerControlExpireJobKey(bot.computer.id, controlLeaseId))
    .catch((error) => {
      // The expired job is harmless after the lease is cleared, so do not report a
      // failed release after the transaction has committed.
      getLogger().error("computer control expiry cancellation", error);
    });

  await enqueueTakeoverContinuation(deps.jobs, released.runId);
  scheduleComputerSleep(deps.jobs, bot.computer.id);
}

export function mapRoutine(row: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  watch: unknown;
  watchState: unknown;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}): Routine {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    crons: row.crons,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    webhookEnabled: row.webhookEnabled,
    githubEnabled: row.githubEnabled,
    messageProvider: row.messageProvider,
    modelProvider: row.modelProvider ? canonicalPiProviderId(row.modelProvider) : null,
    modelId: row.modelId ?? null,
    thinkingLevel: (row.thinkingLevel as Routine["thinkingLevel"]) ?? null,
    watch: parseRoutineWatch(row.watch),
    watchState: parseRoutineWatchState(row.watchState),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRoutinesDto(deps: RouterDeps, actor: Actor, botId: string) {
  const rows = await deps.prisma.routine.findMany({
    where: { botId, spaceId: actor.spaceId },
  });
  return rows.map(mapRoutine);
}

export const os = implement(appContract).$context<{
  actor: Actor | null;
  /** The signed-in session, so a push token ends with the session that registered it. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Re-runs the request's auth so a long-lived stream notices sign-out and revocation. */
  stillAuthorized?: () => Promise<boolean>;
}>();

export const authed = os.use(async ({ context, next }) => {
  const actor = context.actor;
  if (!actor) throw new ORPCError("UNAUTHORIZED");
  return asTenant(actor, () => next({ context: { ...context, actor } }));
});

export function createRouterContext(deps: RouterDeps) {
  const repos = createRepos(deps.prisma);
  const onboardingDeps = { prisma: deps.prisma, events: deps.events, connectors: deps.connectors };
  const mcpOAuth = deps.mcpOAuth ?? new McpOAuthBroker(deps.prisma, deps.secrets);
  const mcpAwaitsOAuth = async (server: McpServerRow, actor: Actor, oauth: McpOAuthSummary) => {
    if (oauth.status === "connected") return false;
    const secret = server.secretId
      ? await deps.prisma.secret.findFirst({
          where: { id: server.secretId, spaceId: actor.spaceId, userId: actor.userId },
        })
      : null;
    const material: McpSecretMaterial = secret
      ? JSON.parse(await deps.secrets.load(secret.ciphertext, { recordId: secret.id }))
      : {};
    const needsGrant = [
      ...Object.values(material.env ?? {}),
      ...Object.values(material.files ?? {}),
    ].some((value) => mcpOAuthEnvReferences(value).fields.length > 0);
    return (
      needsGrant ||
      (oauth.clientId !== null &&
        !material.secret &&
        Object.keys(material.headers ?? {}).length === 0)
    );
  };
  const probeMcpServer = async (server: McpServerRow, actor: Actor): Promise<void> => {
    if (!deps.mcp) return;
    try {
      // The connector records the outcome itself.
      await deps.mcp.probe(server, { spaceId: actor.spaceId, userId: actor.userId });
    } catch {
      getLogger().error("mcp server probe failed", { "mcp.server.id": server.id });
      await recordMcpServerHealth(deps.prisma, server.id, {
        status: "error",
        message: "Could not check this MCP server",
      });
    }
  };
  /**
   * After a server is created, reconfigured or its OAuth connected: show `installing` (stdio
   * may have to download a package) and probe in the background so the settings page turns
   * ok/error without a click. Returns the row with the health the caller should display.
   * Never throws; a probe problem must not fail the save.
   */
  const beginMcpProbe = async (
    row: McpServerRow,
    actor: Actor,
    oauth: McpOAuthSummary,
  ): Promise<McpServerRow> => {
    if (!deps.mcp || !row.enabled) return row;
    const shown = async (
      status: "unknown" | "installing",
      message: string | null,
    ): Promise<McpServerRow> => {
      await recordMcpServerHealth(deps.prisma, row.id, { status, message });
      return {
        ...row,
        healthStatus: status,
        healthMessage: message,
        healthToolCount: null,
        healthCheckedAt: new Date(),
      };
    };
    if (await mcpAwaitsOAuth(row, actor, oauth)) return shown("unknown", MCP_OAUTH_PENDING_MESSAGE);
    const display = row.transport === "stdio" ? await shown("installing", null) : row;
    void probeMcpServer(row, actor);
    return display;
  };
  const codexCatalog = deps.codexCatalog ?? new CodexCatalogCache();
  const favicons = deps.favicons ?? createFaviconResolver();
  const refreshExpiredCredential =
    deps.refreshExpiredModelCredential ??
    ((scope: { userId: string; spaceId: string }, secretId: string, provider: string) =>
      kickModelCredentialRefresh(deps.prisma, deps.secrets, scope, secretId, provider));
  const catalogForSpace = async (actor: Actor) => {
    const auth = await modelCredentialAuthKindsForSpace(deps.prisma, deps.secrets, actor);
    const available = listAvailablePiCatalog(auth.byProvider, auth.byModel);
    const [live, providerLive] = await Promise.all([
      codexLiveCatalogsForSpace(deps.prisma, deps.secrets, actor, auth, codexCatalog, {
        // An expired bearer yields no catalog this round; kick the runtime's
        // locked refresh so the next read can see the account's real list.
        onExpiredToken: (secretId) =>
          refreshExpiredCredential(actor, secretId, CHATGPT_OAUTH_PROVIDER),
      }),
      providerLiveCatalogsForSpace(
        deps.prisma,
        deps.secrets,
        actor,
        auth,
        deps.providerCatalog ?? providerCatalogCache,
      ),
    ]);
    const codexMerged = live.size > 0 ? applyCodexLiveCatalog(available, auth, live) : available;
    const selected = providerLive.size
      ? await savedCatalogSelections(deps.prisma, actor.userId)
      : new Set<string>();
    return applyProviderLiveCatalog(codexMerged, auth, providerLive, selected);
  };
  const groupRepos = createGroupRepos(deps.prisma);
  const taughtSkills = createTaughtSkillsService({
    prisma: deps.prisma,
    events: deps.events,
    jobs: deps.jobs,
    sandbox: deps.sandbox,
    home: deps.home,
    dataDir: deps.dataDir,
  });
  const agentSkills = createAgentSkillsService(deps.prisma);
  const workflows = createWorkflowsService(
    deps.prisma,
    deps.workflowInstaller ??
      (async () => {
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Workflow installation is unavailable.",
        });
      }),
    deps.workflowRunsCancelled,
    deps.workflowRemover,
  );

  const boardEnabled = os
    .use(async ({ next }) => {
      if (!deps.env?.ticketBoardEnabled) throw new ORPCError("NOT_FOUND");
      return next();
    })
    .use(async ({ context, next }) => {
      const actor = context.actor;
      if (!actor) throw new ORPCError("UNAUTHORIZED");
      return asTenant(actor, () => next({ context: { ...context, actor } }));
    });
  const ticketDeps = {
    prisma: deps.prisma,
    ticketBoardEnabled: deps.env?.ticketBoardEnabled,
    onTicketChange: deps.ticketChanges,
  };

  return {
    deps,
    repos,
    onboardingDeps,
    mcpOAuth,
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    codexCatalog,
    favicons,
    refreshExpiredCredential,
    catalogForSpace,
    groupRepos,
    taughtSkills,
    agentSkills,
    workflows,
    boardEnabled,
    ticketDeps,
  };
}

export type RouterContext = ReturnType<typeof createRouterContext>;
