import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  AgentContextStrategy,
  AgentRuntime,
  ConnectorProvider,
  JobPublisher,
  MessagingInboundEvent,
  MessagingSurface,
  NotificationProvider,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import type { ConnectorRegistry, RemoteConnectorDependencies } from "@rakazo/adapters";
import {
  applyMessagingOutboundStatus,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  ComposioConnector,
  createAgentRuntimeSelection,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createJobReconciler,
  createMessagingContextLoader,
  createMessagingExternalConversationHistory,
  createMessagingExternalConversationSender,
  createRunExecutor,
  createRunSecretWriter,
  createSandboxProvider,
  createSecretStore,
  createTicketChangeNotifier,
  createWebProvider,
  destroyBot,
  EmailEmulator,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
  isComposioEnabled,
  isMessagingEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  messagingPlatformsFromEnv,
  PiOAuthLogins,
  PostgresRealtimeFanout,
  piSessionsRoot,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  removePiUserSessions,
  SmtpEmailProvider,
  sandboxProviderOptionsFromEnv,
  toExternalConversationInbound,
  withSecretPersistence,
} from "@rakazo/adapters";
import { bootstrapAdmin, createAuth, isBlockedAuthPath, loopbackTwinOrigins } from "@rakazo/auth";
import type { Actor, AuthCapabilities } from "@rakazo/contracts";
import { SERVER_BUILD_HEADER } from "@rakazo/contracts";
import type { Pool, PrismaClient } from "@rakazo/db";
import {
  contentEncryptionOf,
  createBoardEvents,
  createDb,
  createPool,
  createThreadEvents,
  describeRowSecurity,
  IsolationError,
  parsePositiveInteger,
  requireMembership,
  rowSecurityWarning,
  runAsSystem,
  verifyContentKeys,
} from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import {
  createServiceLogger,
  enrichLogContext,
  getLogger,
  installLogger,
  SERVICE_NAMES,
} from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { storeInboundAttachment } from "./artifacts.js";
import { clientBuildMiddleware, readDeployedWebBuild } from "./client-build.js";
import {
  clientIpMiddleware,
  createClientIpResolver,
  defaultTrustedProxies,
  requestClientIp,
  withClientIp,
} from "./client-ip.js";
import { mountDiagramScript } from "./diagram-script.js";
import type { AppEnv } from "./env.js";
import { loadEnv } from "./env.js";
import {
  ExternalConversationBridge,
  isDeferredReservationLost,
} from "./external-conversation-bridge.js";
import { ModelExternalConversationEngagementJudge } from "./external-conversation-judge.js";
import {
  EXTERNAL_CONVERSATION_STARTUP_SHUTDOWN_MS,
  PendingExternalConversationInbound,
  prefersExternalConversationSurface,
  settleWithTimeout,
} from "./external-conversation-startup.js";
import { healthRoutes } from "./health.js";
import {
  createMessagingInboundHandler,
  externalConversationSenderCanWakeMessageRoutines,
  wakeMessageRoutines,
} from "./messaging-inbound.js";
import { createMessagingReceipts } from "./messaging-receipts.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { mountApiRequestBodyLimits } from "./request-body-limit.js";
import { createRouter } from "./router.js";
import { mountScreenTarget } from "./screen-proxy.js";
import { mountWebhookHttpRoutes } from "./webhook.js";

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  connectors: ConnectorRegistry;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications?: NotificationProvider;
  executor: ReturnType<typeof createRunExecutor>;
  runtime: AgentRuntime;
  awaitIdle?: () => Promise<void>;
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  stop: () => Promise<void>;
}

// Startup and everything it schedules (pollers, team chat, the in-memory job
// queue, retries) runs across tenants. Requests start without a context and get
// one per route: tenant for signed-in procedures, system for auth and webhooks.
export function createApp(overrides: CreateAppOverrides = {}): Promise<AppHandles> {
  return runAsSystem("api startup and background work", () => buildApp(overrides));
}

type CreateAppOverrides = Partial<AppEnv> & {
  prisma?: PrismaClient;
  realtime?: RealtimeFanout;
  sandbox?: SandboxProvider;
  /** Test-only connector providers registered beside the configured ones. */
  connectors?: ConnectorProvider[];
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications?: NotificationProvider;
  remoteConnectors?: RemoteConnectorDependencies;
  logger?: Logger;
  runtime?: AgentRuntime;
  contextStrategy?: AgentContextStrategy;
};

async function buildApp(overrides: CreateAppOverrides): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    sandbox: sandboxOverride,
    connectors: connectorOverrides = [],
    messaging: messagingOverride,
    email: emailOverride,
    notifications,
    remoteConnectors,
    logger: loggerOverride,
    runtime: runtimeOverride,
    contextStrategy,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const logger = loggerOverride ?? createServiceLogger({ service: SERVICE_NAMES.api });
  installLogger(logger);
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl, {
        poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
        applicationName: "rakazo-api",
        encryptContent: env.contentEncryption,
      });
  let { prisma } = created;
  try {
    await bootstrapAdmin(prisma, { email: env.adminEmail, password: env.adminPassword });
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    await created.pool?.end().catch(() => undefined);
    throw error;
  }
  // Built before anything listens, so a bad TRUSTED_PROXIES entry stops startup.
  const clientIp = createClientIpResolver({
    // Unset trusts the proxies a stack is built with: on loopback or on the API's own networks.
    // Trusting none would make the web proxy every client, one sign-in rate-limit bucket for all.
    trustedProxies: env.trustedProxies.length > 0 ? env.trustedProxies : defaultTrustedProxies(),
    header: env.clientIpHeader,
  });
  const rowSecurity = rowSecurityWarning(await describeRowSecurity(prisma));
  if (rowSecurity) logger.warn(rowSecurity);
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const secrets = createSecretStore(env.encryptionKey, realtime);
  await secrets.start();
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets);
  const unreadableMasterKeys = await verifyContentKeys(prisma);
  if (unreadableMasterKeys.length)
    logger.error("Stored space keys need master keys that are not configured", undefined, {
      masterKeyIds: unreadableMasterKeys,
    });
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
    defaultRuntime: runtimeOverride?.describe().id ?? env.agentRuntime,
  });
  const ticketBoardEnabled = env.ticketBoardEnabled;
  const boardEvents = createBoardEvents(realtime);
  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  // prismaOverride skips createDb, so there is no shared pool. The previous
  // GraphileJobPublisher(databaseUrl) path opened its own connections; keep a
  // bounded pool for that override path instead of passing undefined.
  let ownedJobPool: Pool | undefined;
  if (!inMemoryJobs && !created.pool) {
    ownedJobPool = createPool(env.databaseUrl, {
      poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
      applicationName: "rakazo-api-jobs",
    });
  }
  const jobPool = created.pool ?? ownedJobPool;
  const jobs = inMemoryJobs
    ? inMemoryJobs
    : new GraphileJobPublisher(
        jobPool ??
          (() => {
            throw new Error("Graphile job publisher requires a PostgreSQL pool");
          })(),
      );
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  const sandbox: SandboxProvider =
    sandboxOverride ??
    createSandboxProvider(env.sandboxProvider, {
      ...sandboxProviderOptionsFromEnv(),
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
    });
  const mcpOAuth = new McpOAuthBroker(
    prisma,
    secrets,
    remoteConnectors,
    env.mcpAllowPrivateEndpoint,
  );
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const artifacts = new LocalArtifactStore(env.dataDir, contentEncryptionOf(prisma)?.ring);
  const memory = new MarkdownMemoryStore(prisma);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      ...env.mcpStdio,
      network: remoteConnectors,
      events,
      allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const messagingPlatforms = messagingPlatformsFromEnv(env);
  const messaging =
    messagingOverride ??
    (isMessagingEnabled(messagingPlatforms)
      ? new ChatSdkMessagingSurface(messagingPlatforms)
      : undefined);
  const localEmailEmulator =
    !emailOverride && !env.smtpUrl && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLoopbackHost(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined =
    emailOverride ??
    (env.smtpUrl
      ? new SmtpEmailProvider({ url: env.smtpUrl, from: env.emailFrom ?? "" })
      : localEmailEmulator);
  const installed = new InstalledConnectorProvider(
    prisma,
    secrets,
    remoteConnectors,
    env.mcpAllowPrivateEndpoint,
  );
  const composio = isComposioEnabled(env.composioApiKey)
    ? new ComposioConnector({ apiKey: env.composioApiKey })
    : undefined;
  const stack = createConnectorStack([
    ...(composio ? [composio] : []),
    installed,
    mcp,
    ...connectorOverrides,
  ]);
  const selection = createAgentRuntimeSelection({
    defaultRuntime: env.agentRuntime,
    dataDir: env.dataDir,
    piSessionRoot: env.piSessionRecording ? piSessionsRoot(env.dataDir) : undefined,
  });
  const runtime = runtimeOverride ?? selection.runtime;
  const auth = createAuth(prisma, {
    breachedPasswordCheck: env.breachedPasswordCheck,
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    email,
    logger: {
      level: "error",
      log: (_level, _message, ...args) =>
        getLogger().error(
          "auth.request.failed",
          args.find((arg) => arg instanceof Error),
        ),
    },
    onEmailError: (error) => getLogger().error("transactional email delivery failed", error),
    beforeDeleteUser: async (userId) => {
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, userId: true, spaceId: true, name: true, archivedAt: true },
      });
      await Promise.all(
        bots.map((bot) =>
          destroyBot(
            { prisma, sandbox, home, jobs, artifacts, dataDir: env.dataDir },
            bot,
            {
              operationId: `account-delete:${userId}`,
              traceId: `account-delete:${userId}`,
              spaceId: bot.spaceId,
              userId,
              botId: bot.id,
              signal: new AbortController().signal,
            },
            { deleteMemories: true },
          ),
        ),
      );
      await removePiUserSessions(env.dataDir, userId);
    },
  });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection({
    CLOUD_AGENT_PROVIDER: env.cloudAgentProvider,
    CURSOR_API_KEY: env.cursorApiKey,
    CLOUD_AGENT_SPACE_ID: env.cloudAgentSpaceId,
  });
  const shutdown = new AbortController();
  // One cache serves models.list, selection validation, and run-time model
  // resolution alike, so a list call warms the run path in this process.
  const codexCatalog = new CodexCatalogCache();
  const executor = createRunExecutor({
    maxUploadSizeBytes: env.maxUploadSizeBytes,
    contextStrategy,
    prisma,
    runtime,
    runtimeFor: runtimeOverride ? undefined : selection.runtimeFor,
    codexCatalog,
    sandbox,
    memory,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: async (userId) => {
      const provider = stack.connector.managed("composio");
      if (!provider) return [];
      return provider.listConnectedExternalIds({
        userId,
        spaceId: "",
        operationId: "connections.sync",
        traceId: "connections.sync",
        signal: AbortSignal.timeout(15_000),
      });
    },
    secrets: [
      env.deploymentModelKey ?? "",
      env.composioApiKey ?? "",
      env.cursorApiKey ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    secretHttp: remoteConnectors,
    mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    dataDir: env.dataDir,
    notifications,
    jobs,
    events,
    onTicketChange: ticketChanges,
    ticketBoardEnabled,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
    shutdownSignal: shutdown.signal,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: "api",
    runtime,
    secretStore: secrets,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    messaging,
    cloudAgent,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs
    ? createJobReconciler({
        prisma,
        jobs,
        events,
        notifications,
        reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
        reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
      })
    : undefined;
  reconciler?.start();

  const router = createRouter({
    cloudAgent,
    codexCatalog,
    prisma,
    events,
    ticketChanges,
    boardEvents,
    auth,
    jobs,
    sandbox,
    memory,
    home,
    secrets,
    oauthLogins,
    mcpOAuth,
    mcp,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    dataDir: env.dataDir,
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
    },
    env: {
      ticketBoardEnabled,
      agentRuntime: env.agentRuntime,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      externalConversationJudgeProvider: env.externalConversationJudgeProvider,
      externalConversationJudgeModel: env.externalConversationJudgeModel,
      deploymentModelConfigured: env.deploymentModelConfigured,
      deploymentModelHostCredentials: env.deploymentModelHostCredentials,
      webOrigin: env.webOrigin,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      gitSha: env.gitSha,
      integrationsCatalogUrl: env.integrationsCatalogUrl,
      mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
  });
  const app = new Hono();
  app.use("*", requestLogging(logger));
  app.use("*", clientIpMiddleware(clientIp, env.clientIpHeader));
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
      exposeHeaders: [SERVER_BUILD_HEADER],
    }),
  );
  // Session and account replies must never be stored by a client or an HTTP cache.
  for (const path of ["/api/auth/*", "/rpc/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    });
  }
  app.get("/api/auth/capabilities", (c) => {
    return c.json({
      passwordReset: Boolean(email),
      resetUrl: email ? new URL("/reset-password", env.webOrigin).href : null,
    } satisfies AuthCapabilities);
  });
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  mountApiRequestBodyLimits(app, env.maxUploadSizeBytes);
  mountScreenTarget(app, prisma, env.screenProxySecret);
  mountDiagramScript(app);
  // Account and session tables, signup bootstrap and account deletion span tenants;
  // webhooks authenticate a bot or provider, then resolve the tenant from it.
  for (const [path, reason] of [
    ["/api/auth/*", "authentication"],
    ["/api/v1/bots/*", "bot webhook"],
    ["/api/v1/messaging/*", "messaging webhook"],
    ["/api/v1/phone/*", "messaging webhook"],
  ] as const) {
    app.use(path, (_c, next) => runAsSystem(reason, next));
  }
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (isBlockedAuthPath(path)) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    const ip = requestClientIp(c);
    const response = await auth.handler(withClientIp(emptyAuthBodyAsJson(c.req.raw), ip));
    return response;
  });
  const requestSession = async (request: Request) => {
    // The bearer plugin turns a signed `Authorization: Bearer` into the session cookie.
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    const actor = await actorFromMembership(
      requireMembership(prisma, session.user.id, request.headers.get("x-rakazo-space-id")),
    );
    return actor && { actor, sessionId: session.session.id };
  };
  const sessionActor = async (request: Request) => (await requestSession(request))?.actor ?? null;
  app.use(
    "/rpc/*",
    clientBuildMiddleware({
      webBuild: readDeployedWebBuild(),
      minimums: env.minimumClientBuilds ?? {},
    }),
  );
  app.use("/rpc/*", async (c, next) => {
    const session = await requestSession(c.req.raw);
    const actor = session?.actor ?? null;
    if (actor) {
      enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: {
        actor,
        sessionId: session?.sessionId,
        signal: c.req.raw.signal,
        // Same user in the same space, so leaving the space also ends a stream.
        // A database failure rejects this check; only a missing membership is unauthorized.
        stillAuthorized: async () => {
          const current = await sessionActor(c.req.raw);
          return Boolean(
            actor && current?.userId === actor.userId && current.spaceId === actor.spaceId,
          );
        },
      },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs });
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let clearMessagingRetryDelay: (() => void) | undefined;
  let messagingInitTask: Promise<void> | undefined;
  let clearExternalConversationRetryDelay: (() => void) | undefined;
  let externalConversationInitTask: Promise<void> | undefined;
  // Messaging webhooks only exist when the surface is enabled.
  let externalConversationBridge: ExternalConversationBridge | undefined;
  /** Constructed even before start() succeeds so stop() can cancel in-flight startup. */
  let externalConversationBridgeInstance: ExternalConversationBridge | undefined;
  const pendingExternalConversationInbound = new PendingExternalConversationInbound();
  const receipts = messaging ? createMessagingReceipts(messaging) : undefined;
  if (messaging) {
    const inboundDeps = {
      prisma,
      events,
      jobs,
      acknowledge: receipts?.acknowledge,
    } satisfies Parameters<typeof createMessagingInboundHandler>[0];
    const inbound = createMessagingInboundHandler(inboundDeps);
    const handleExternalConversationInbound = async (
      bridge: ExternalConversationBridge,
      event: Parameters<typeof wakeMessageRoutines>[2],
    ) => {
      const mapped = toExternalConversationInbound(event);
      if (!mapped) {
        await inbound(event);
        return;
      }
      const canWake = await externalConversationSenderCanWakeMessageRoutines(inboundDeps, event);
      if (!canWake) {
        await bridge.receive(mapped);
        return;
      }

      // Persist a non-reconcilable row until routine routing owns or releases
      // the message, so the timer cannot start a second ExternalConversation run.
      const target = await bridge.receive(mapped, { queueAgent: false });
      if (!target.deferred) return;
      const leaseHeartbeat = await bridge.startDeferredReservationHeartbeat(
        target.externalMessageId,
      );
      let woken = false;
      bridge.markRoutineWakeInFlight(target.externalMessageId);
      try {
        const wakePromise = wakeMessageRoutines(inboundDeps, target, event, {
          // Must match ExternalConversationBridge ExternalConversation / recovery provider.
          deliveryProvider: bridge.providerId,
          externalMessageId: target.externalMessageId,
        });
        try {
          woken = await Promise.race([wakePromise, leaseHeartbeat.lost]);
        } catch (error) {
          if (isDeferredReservationLost(error)) {
            // Lease loss must not start a fallback agent beside an in-flight
            // wake: re-hold exclusive ownership while awaiting that wake, then
            // resolve from its settled result.
            let hold: { stop: () => void } | undefined;
            try {
              hold = await bridge.startDeferredReservationHeartbeat(target.externalMessageId);
            } catch {
              // Row already left deferred; wake CAS / resolve decide the winner.
            }
            try {
              try {
                woken = await wakePromise;
              } catch (wakeError) {
                const released = await bridge.resolveDeferredMessage(
                  target.externalMessageId,
                  "agent",
                  mapped.kind,
                );
                if (!released) {
                  throw new Error("Team chat deferred message ownership conflict", {
                    cause: wakeError,
                  });
                }
                await bridge.reconcileOnce();
                getLogger().error(
                  "team chat routine wake failed after deferred lease loss",
                  wakeError,
                );
                return;
              }
            } finally {
              hold?.stop();
            }
          } else {
            await bridge.resolveDeferredMessage(target.externalMessageId, "agent", mapped.kind);
            await bridge.reconcileOnce();
            throw error;
          }
        }
        const resolved = await bridge.resolveDeferredMessage(
          target.externalMessageId,
          woken ? "routine" : "agent",
          mapped.kind,
        );
        if (!resolved) {
          throw new Error("Team chat deferred message ownership conflict");
        }
        if (!woken) await bridge.reconcileOnce();
      } finally {
        bridge.clearRoutineWakeInFlight(target.externalMessageId);
        leaseHeartbeat.stop();
      }
    };
    const flushPendingExternalConversationInbound = (bridge: ExternalConversationBridge) => {
      pendingExternalConversationInbound.flush((event) =>
        handleExternalConversationInbound(bridge, event),
      );
    };
    const externalPlatform = messaging.platforms().find((platform) => platform.capabilities.groups);
    if (env.externalConversationBotId && externalPlatform) {
      const judge =
        env.externalConversationJudgeProvider && env.externalConversationJudgeModel
          ? new ModelExternalConversationEngagementJudge({
              prisma,
              runtime,
              secrets,
              deploymentProvider: env.defaultProvider,
              deploymentModel: env.defaultModel,
              deploymentModelKey: env.deploymentModelKey,
              allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
              providerOverride: env.externalConversationJudgeProvider,
              modelOverride: env.externalConversationJudgeModel,
            })
          : new ModelExternalConversationEngagementJudge({
              prisma,
              runtime,
              secrets,
              deploymentProvider: env.defaultProvider,
              deploymentModel: env.defaultModel,
              deploymentModelKey: env.deploymentModelKey,
              allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
            });
      const bridge = new ExternalConversationBridge({
        prisma,
        events,
        jobs,
        send: createMessagingExternalConversationSender(messaging),
        fetchThreadHistory: createMessagingExternalConversationHistory(messaging),
        storeAttachment: ({ spaceId, userId, ...input }) =>
          storeInboundAttachment(
            { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
            { spaceId, userId },
            input,
          ),
        providerId: externalPlatform.provider,
        botId: env.externalConversationBotId,
        judge,
        acknowledge: receipts?.acknowledge,
      });
      externalConversationBridgeInstance = bridge;
      try {
        await bridge.start();
        externalConversationBridge = bridge;
      } catch (error) {
        getLogger().error("team chat bridge failed to start; retrying", error);
        externalConversationInitTask = (async () => {
          let delayMs = 2_000;
          while (!messagingStopped) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delayMs);
              clearExternalConversationRetryDelay = () => {
                clearTimeout(timer);
                clearExternalConversationRetryDelay = undefined;
                resolve();
              };
            });
            clearExternalConversationRetryDelay = undefined;
            if (messagingStopped) return;
            try {
              await bridge.start();
              if (messagingStopped) {
                await bridge.stop();
                return;
              }
              externalConversationBridge = bridge;
              flushPendingExternalConversationInbound(bridge);
              return;
            } catch (retryError) {
              if (
                retryError instanceof Error &&
                retryError.message === "Team chat bridge start cancelled"
              ) {
                return;
              }
              getLogger().error("team chat bridge failed to start; retrying", retryError);
              delayMs = Math.min(delayMs * 5, 30_000);
            }
          }
        })();
      }
    }
    const handleInbound = async (event: MessagingInboundEvent) => {
      if (event.type !== "message") {
        await applyMessagingOutboundStatus(prisma, event);
        return;
      }
      if (prefersExternalConversationSurface(event, env.externalConversationBotId)) {
        const bridge = externalConversationBridge;
        if (bridge) {
          await handleExternalConversationInbound(bridge, event);
          return;
        }
        // Bridge is still starting (or retrying). Do not fall through to the
        // personal-line inbound path — that bypasses externalMessage ownership
        // and can wake routines for unlinked ExternalConversation senders.
        if (externalConversationInitTask) {
          const pending = pendingExternalConversationInbound.enqueue(event);
          if (!pending) {
            throw new Error("Team chat inbound buffer is full");
          }
          await pending;
          return;
        }
        throw new Error("Team chat bridge is unavailable");
      }
      await inbound(event);
    };
    messaging.onInbound((event) => runAsSystem("messaging inbound", () => handleInbound(event)));
    mountMessagingWebhookRoutes(app, { messaging });
    // Start polling-mode adapters eagerly instead of waiting for the first webhook
    // or outbound send. This process owns the inbound sink registered above, so
    // it must also own the receive loop; a second poller in another process would
    // compete for updates without delivering them to this sink.
    // Bounded retries cover transient startup failures so recovery does not depend
    // on an unrelated outbound send initializing the adapter again.
    messagingInitTask = (async () => {
      const delayMs = [0, 2_000, 10_000];
      for (let attempt = 0; attempt < delayMs.length; attempt += 1) {
        if (messagingStopped) return;
        if (delayMs[attempt]! > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs[attempt]);
            clearMessagingRetryDelay = () => {
              clearTimeout(timer);
              clearMessagingRetryDelay = undefined;
              resolve();
            };
          });
          clearMessagingRetryDelay = undefined;
        }
        if (messagingStopped) return;
        try {
          await messaging.initialize?.();
          return;
        } catch (error) {
          getLogger().error(
            attempt === delayMs.length - 1
              ? "messaging surface initialize failed"
              : "messaging surface initialize failed; retrying",
            error,
          );
        }
      }
    })();
  }

  app.route(
    "/",
    healthRoutes(
      () => ({
        runtime: env.agentRuntime,
        sandbox: env.sandboxProvider,
        messaging: Boolean(messaging),
        email: email?.describe().id ?? null,
        jobs: jobKind,
        realtime: realtime.describe().id,
        secrets: secrets.describe(),
        degraded: secrets.describe().capabilities.degraded ?? false,
        revision: env.gitSha ?? null,
      }),
      // The statement timeout ends a stuck probe on the server too, freeing its connection.
      () =>
        prisma.$transaction([
          prisma.$executeRaw`SET LOCAL statement_timeout = 1500`,
          prisma.$queryRaw`SELECT 1`,
        ]),
    ),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    connectors: stack.connector,
    messaging,
    email,
    notifications,
    executor,
    runtime,
    awaitIdle: inMemoryJobs ? () => inMemoryJobs.awaitIdle() : undefined,
    backgroundFailures: inMemoryJobs ? () => inMemoryJobs.failureCounts() : undefined,
    stop: async () => {
      // Abort in-flight continueRun boot waits before draining jobs so stop() cannot sit
      // on waitForComputerReady for the full boot-wait window during shared Postgres journeys.
      shutdown.abort();
      oauthLogins.abortAll();
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      clearExternalConversationRetryDelay?.();
      receipts?.stop();
      pendingExternalConversationInbound.reject(
        new Error("Team chat bridge stopped before startup"),
      );
      // Cancel in-flight start() before awaiting the retry task so stop() cannot
      // sit on DB/reconcile work that bridge.start() is still running.
      await settleWithTimeout(
        externalConversationBridgeInstance
          ? externalConversationBridgeInstance.stop().catch(() => undefined)
          : undefined,
        EXTERNAL_CONVERSATION_STARTUP_SHUTDOWN_MS,
      );
      await messagingInitTask?.catch(() => undefined);
      await settleWithTimeout(
        externalConversationInitTask,
        EXTERNAL_CONVERSATION_STARTUP_SHUTDOWN_MS,
      );
      await messaging?.shutdown?.();
      await externalConversationBridge?.stop();
      await email?.drain?.();
      await reconciler?.stop();
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
      await ownedJobPool?.end().catch(() => undefined);
      await logger.flush({ timeoutMs: 2_000 });
    },
  };
}

export function isTrustedOrigin(
  origin: string,
  env: Pick<AppEnv, "webOrigin" | "apiUrl" | "authUrl">,
) {
  if (!origin) return true;
  const allowed = new Set([env.webOrigin, env.apiUrl, env.authUrl].flatMap(originVariants));
  return allowed.has(origin);
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function originVariants(origin: string): string[] {
  if (!origin) return [];
  const variants = [origin, ...loopbackTwinOrigins(origin)];
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" || url.protocol === "https:") {
      variants.push(url.origin);
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      const v6 = new URL(origin);
      v6.hostname = "[::1]";
      variants.push(v6.origin);
    }
  } catch {
    return variants;
  }
  return variants;
}

/**
 * No membership is no actor, which the RPC layer answers as 401. A database
 * failure, including the deployment-settings lookup, must stay a server error
 * so a blip does not look like a rejected session.
 */
export async function actorFromMembership(membership: Promise<Actor>): Promise<Actor | null> {
  try {
    return await membership;
  } catch (error) {
    if (error instanceof IsolationError) return null;
    throw error;
  }
}

/**
 * Some clients POST auth actions with an empty body (older phone sign-out, the web deletion code);
 * Better Auth rejects that before the endpoint runs.
 */
function emptyAuthBodyAsJson(request: Request) {
  if (
    request.method !== "POST" ||
    request.headers.get("content-length") !== "0" ||
    request.headers.has("transfer-encoding")
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request, { headers, body: "{}" });
}

/**
 * An ORPCError is a decision the router made (BAD_REQUEST, UNAUTHORIZED, ...) and reaches the
 * caller intact. Everything else is flattened into an opaque "Internal server error", so
 * unless it is logged here the only record of what actually broke is gone.
 *
 * The cause chain matters as much as the message: undici and most SDKs report a bare
 * "fetch failed" and keep the host and errno one level down.
 */
/** Log the failure, then give known failures their own status instead of a generic 500. */
export function handleRpcError(error: unknown, path: readonly string[]): void {
  // A missing or foreign resource is the caller's mistake (a stale client, a deleted bot),
  // not a server failure, so it is a warning rather than an error report.
  if (error instanceof IsolationError) {
    getLogger().warn(`rpc ${path.join("/")} not found`, { "error.stack": error.stack });
    throw new ORPCError("NOT_FOUND", { message: error.message, cause: error });
  }
  logUnexpectedRpcError(error, path);
  if (error instanceof SandboxRateLimitError) {
    throw new ORPCError("TOO_MANY_REQUESTS", { message: error.message, cause: error });
  }
}

export function logUnexpectedRpcError(error: unknown, path: readonly string[]): void {
  if (error instanceof ORPCError) return;
  const where = `rpc ${path.join("/")} failed`;
  getLogger().error(where, error);
}
