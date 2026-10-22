import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createWorkerSecretStore } from "./secret-store.js";

loadRootEnv();

import {
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  ComposioConnector,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createJobReconciler,
  createMessagingContextLoader,
  createPostgresReconciliationLeadership,
  createRoutineRetryNoticeReconciler,
  createRunExecutor,
  createRunSecretWriter,
  createSandboxProvider,
  createTicketChangeNotifier,
  createWebProvider,
  databaseCapacityBackoffMs,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  isComposioEnabled,
  isMessagingEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  mcpStdioOptionsFromEnv,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PostgresRealtimeFanout,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  resolveDeploymentModel,
  resolvePiSessionRoot,
  resolveSandboxProvider,
  ScriptedAgentRuntime,
  sandboxProviderOptionsFromEnv,
  withSecretPersistence,
} from "@rakazo/adapters";
import { resolveSupervisorToken, uploadSizeFromEnv } from "@rakazo/core";
import {
  contentEncryptionOf,
  createBoardEvents,
  createDb,
  createThreadEvents,
  describeRowSecurity,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
  rowSecurityWarning,
  runAsSystem,
  verifyContentKeys,
} from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/root";
import { MarkdownMemoryStore } from "@rakazo/memory";

const logger = createRootLogger(SERVICE_NAMES.worker);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  // Shared by Prisma, the reconciliation leadership lock, and both graphile-worker
  // components (see GraphileJobPublisher/GraphileJobWorkerHost) — one pool instead
  // of four separate ones. Keep this modest: graphile holds a LISTEN client and
  // leadership holds an advisory-lock client for the process lifetime, and a
  // larger max just competes for Postgres max_connections (53300).
  const created = createDb(databaseUrl, {
    poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 8),
    applicationName: "rakazo-worker",
  });
  const { pool } = created;
  let { prisma } = created;
  const rowSecurity = rowSecurityWarning(await describeRowSecurity(prisma));
  if (rowSecurity) logger.warn(rowSecurity);
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const secrets = await createWorkerSecretStore(process.env, realtime);
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
  });
  const ticketBoardEnabled = process.env.TICKET_BOARD_ENABLED === "true";
  const boardEvents = createBoardEvents(realtime);
  const dataDir = process.env.DATA_DIR ?? "./data";
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: resolvePiSessionRoot(dataDir) });
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const { key: deploymentModelKey, configured: deploymentModelConfigured } =
    resolveDeploymentModel();
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = createSandboxProvider(sandboxProvider, {
    ...sandboxProviderOptionsFromEnv(process.env),
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
  });
  const allowPrivateEndpoint = process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true";
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, {}, allowPrivateEndpoint);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      ...mcpStdioOptionsFromEnv(process.env),
      events,
      allowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env));
  const messaging = isMessagingEnabled(messagingPlatforms)
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const composio = isComposioEnabled(process.env.COMPOSIO_API_KEY)
    ? new ComposioConnector({ apiKey: process.env.COMPOSIO_API_KEY })
    : undefined;
  const stack = createConnectorStack([
    ...(composio ? [composio] : []),
    new InstalledConnectorProvider(prisma, secrets, {}, allowPrivateEndpoint),
    mcp,
  ]);
  const home = new LocalAgentHomeStore(dataDir);
  const artifacts = new LocalArtifactStore(dataDir, contentEncryptionOf(prisma)?.ring);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(pool);
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection();
  const executor = createRunExecutor({
    maxUploadSizeBytes: uploadSizeFromEnv(process.env),
    prisma,
    runtime,
    // Live per-account Codex catalog; never refreshes or writes credentials.
    codexCatalog: new CodexCatalogCache(),
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: async (userId) => {
      if (!composio) return [];
      return composio.listConnectedExternalIds({
        userId,
        spaceId: "",
        operationId: "connections.sync",
        traceId: "connections.sync",
        signal: AbortSignal.timeout(15_000),
      });
    },
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      process.env.CURSOR_API_KEY ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    mcpAllowPrivateEndpoint: process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    deploymentModelKey,
    deploymentModelConfigured,
    dataDir,
    jobs,
    events,
    onTicketChange: ticketChanges,
    ticketBoardEnabled,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
  });

  const jobHost: JobWorkerHost =
    inMemoryJobs ??
    new GraphileJobWorkerHost(pool, {
      concurrency: parsePositiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 4),
    });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: process.pid.toString(),
    runtime,
    secretStore: secrets,
    deploymentModelKey,
    deploymentModelConfigured,
    messaging,
    cloudAgent,
  });
  // graphile-worker run() connects through the shared pool. createPool already
  // retries connect() on 53300 a finite number of times. Keep retrying start
  // until Postgres has capacity: exhausting then returning from main().catch
  // left a live process that held connections but never ran jobs or registered
  // signal handlers, even after capacity returned. Do not exit(1) here; that
  // crash-loops into the same saturated Postgres. GraphileJobWorkerHost also
  // observes runner.promise after start and restarts with the same backoff if
  // the runner dies later on 53300 (unhandledRejection still swallows that
  // code so we do not Docker crash-loop on transient completeJob failures).
  for (let attempt = 0; ; attempt += 1) {
    try {
      await jobHost.start(jobHandlers);
      break;
    } catch (error) {
      if (!isTooManyDatabaseConnections(error)) throw error;
      logger.error("worker job host start waiting on database capacity", error);
      await new Promise((resolve) => setTimeout(resolve, databaseCapacityBackoffMs(attempt)));
    }
  }
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    leadership: createPostgresReconciliationLeadership(pool),
    reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
    reconcileRoutineRetryNotices: inMemoryJobs
      ? undefined
      : createRoutineRetryNoticeReconciler(pool, (runId) =>
          executor.notifyRoutineRetryAttemptsExhausted(runId),
        ),
  });
  reconciler.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await reconciler.stop();
      await jobHost.stop();
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    } finally {
      await logger.flush({ timeoutMs: 2_000 });
    }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  // graphile-worker fires completeJob() without awaiting it. When pool.connect()
  // then hits Postgres 53300, that rejection is unhandled. Exiting here is the
  // crash loop: Docker restarts the process before Postgres has reaped the old
  // backends, so the next boot cannot connect either. Stay up on that rejection
  // only — do not resume after uncaughtException (Node leaves the process in an
  // undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason)) return;
    void stop().finally(() => process.exit(1));
  });

  logger.info("worker ready", { degraded: secrets.describe().capabilities.degraded ?? false });
}

// The worker only does cross-tenant work: job dispatch, reconcilers, leadership and
// realtime, all keyed by ids rather than a signed-in user. This is its one
// row-level security bypass; jobs re-enter it explicitly (see wakeup.ts).
runAsSystem("worker process", main).catch(async (error) => {
  logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  // jobHost.start retries 53300 without bound above, so a saturated Postgres at
  // that step does not reach here. Other startup failures still exit.
  process.exit(1);
});
