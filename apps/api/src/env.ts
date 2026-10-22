import {
  mcpStdioOptionsFromEnv,
  resolveCloudAgentProvider,
  resolveDeploymentModel,
  resolveSandboxProvider,
} from "@rakazo/adapters";
import type { MinimumClientBuilds } from "@rakazo/contracts";
import { parseMinimumClientBuilds } from "@rakazo/contracts";
import {
  resolveAuthSecret,
  resolveContentEncryption,
  resolveEncryptionKey,
  resolveScreenProxySecret,
  resolveSupervisorToken,
  uploadSizeFromEnv,
} from "@rakazo/core";

export { resolveCloudAgentProvider, resolveSandboxProvider } from "@rakazo/adapters";

export interface AppEnv {
  adminEmail?: string;
  adminPassword?: string;
  /** Opt-in Have I Been Pwned check for new passwords. Default off: it calls an outside service. */
  breachedPasswordCheck?: boolean;
  nodeEnv: string;
  databaseUrl: string;
  realtimeDatabaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  apiUrl: string;
  apiHost: string;
  /** Proxies whose forwarded client address is believed; empty means local networks. */
  trustedProxies: string[];
  /** The header those proxies set. */
  clientIpHeader: string;
  encryptionKey: string;
  /** CONTENT_ENCRYPTION: whether new content is encrypted at rest. */
  contentEncryption: boolean;
  dataDir: string;
  /** Opt-in Pi JSONL session recording under DATA_DIR/pi-sessions. Default off. */
  piSessionRecording: boolean;
  ticketBoardEnabled: boolean;
  maxUploadSizeBytes: number;
  sandboxSupervisorUrl: string;
  sandboxSupervisorToken: string | undefined;
  screenProxySecret: string;
  sandboxProvider: string;
  cloudAgentProvider: string;
  cloudAgentSpaceId: string | undefined;
  cursorApiKey: string | undefined;
  agentRuntime: string;
  deploymentModelKey: string | undefined;
  /** The deployment default model can run; see resolveDeploymentModel. */
  deploymentModelConfigured: boolean;
  /** The deployment default model runs on the host's credentials rather than a key. */
  deploymentModelHostCredentials: boolean;
  /** Optional integrations.sh-compatible catalog base URL. */
  integrationsCatalogUrl: string | undefined;
  smtpUrl: string | undefined;
  emailFrom: string | undefined;
  emailEmulator: boolean;
  larkAppId: string | undefined;
  larkAppSecret: string | undefined;
  larkVerificationToken: string | undefined;
  larkEncryptKey: string | undefined;
  larkDomain: string | undefined;
  /** Bot that owns linked external conversations. */
  externalConversationBotId: string | undefined;
  /** Optional model override for ambient engagement judging. */
  externalConversationJudgeProvider: string | undefined;
  externalConversationJudgeModel: string | undefined;
  defaultProvider: string;
  defaultModel: string;
  wakeupDriver: string;
  mcpStdioEnabled: boolean;
  mcpStdioAllowedCommands: string[];
  /** Package dir, install/startup timeouts and idle reaping for stdio MCP servers. */
  mcpStdio: ReturnType<typeof mcpStdioOptionsFromEnv>;
  /** Deployment-owner escape for remote MCP on RFC1918 / Docker-network hosts. */
  mcpAllowPrivateEndpoint: boolean;
  port: number;
  gitSha: string | undefined;
  /** Oldest client build per kind the API still serves (RAKAZO_MIN_CLIENT_BUILD). */
  minimumClientBuilds?: MinimumClientBuilds;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (
    source.AUTH_BREACHED_PASSWORD_CHECK_ENABLED &&
    !["true", "false"].includes(source.AUTH_BREACHED_PASSWORD_CHECK_ENABLED)
  ) {
    throw new Error("AUTH_BREACHED_PASSWORD_CHECK_ENABLED must be true or false");
  }
  const authSecret = resolveAuthSecret(source);
  const sandboxProvider = resolveSandboxProvider(source);
  const cloudAgentProvider = resolveCloudAgentProvider(source);
  const deploymentModel = resolveDeploymentModel(source);
  return {
    adminEmail: optional(source.RAKAZO_ADMIN_EMAIL),
    adminPassword: source.RAKAZO_ADMIN_PASSWORD || undefined,
    breachedPasswordCheck: source.AUTH_BREACHED_PASSWORD_CHECK_ENABLED === "true",
    nodeEnv: source.NODE_ENV ?? "",
    databaseUrl: required(source, "DATABASE_URL"),
    realtimeDatabaseUrl: source.REALTIME_DATABASE_URL ?? required(source, "DATABASE_URL"),
    authSecret,
    authUrl: source.BETTER_AUTH_URL ?? source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    webOrigin: source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    apiUrl: source.API_URL ?? "http://127.0.0.1:3100",
    apiHost: source.API_HOST ?? "127.0.0.1",
    trustedProxies: (source.TRUSTED_PROXIES ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    clientIpHeader: optional(source.CLIENT_IP_HEADER)?.toLowerCase() ?? "x-forwarded-for",
    encryptionKey: resolveEncryptionKey(source),
    contentEncryption: resolveContentEncryption(source),
    dataDir: source.DATA_DIR ?? "./data",
    piSessionRecording: source.PI_SESSION_RECORDING === "true",
    ticketBoardEnabled: source.TICKET_BOARD_ENABLED === "true",
    maxUploadSizeBytes: uploadSizeFromEnv(source),
    sandboxSupervisorUrl: source.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    sandboxSupervisorToken:
      sandboxProvider === "docker" ? resolveSupervisorToken(source) : undefined,
    screenProxySecret: resolveScreenProxySecret(source),
    sandboxProvider,
    cloudAgentProvider,
    cloudAgentSpaceId: optional(source.CLOUD_AGENT_SPACE_ID),
    cursorApiKey: optional(source.CURSOR_API_KEY),
    agentRuntime: source.AGENT_RUNTIME ?? "pi",
    // Provider, model and key resolve together: see resolveDeploymentModel.
    deploymentModelKey: deploymentModel.key,
    deploymentModelConfigured: deploymentModel.configured,
    deploymentModelHostCredentials: deploymentModel.hostCredentials,
    integrationsCatalogUrl: optional(source.INTEGRATIONS_CATALOG_URL),
    smtpUrl: optional(source.SMTP_URL),
    emailFrom: optional(source.EMAIL_FROM),
    emailEmulator: source.EMAIL_EMULATOR === "true" && source.NODE_ENV !== "production",
    larkAppId: optional(source.LARK_APP_ID),
    larkAppSecret: optional(source.LARK_APP_SECRET),
    larkVerificationToken: optional(source.LARK_VERIFICATION_TOKEN),
    larkEncryptKey: optional(source.LARK_ENCRYPT_KEY),
    larkDomain: optional(source.LARK_DOMAIN),
    externalConversationBotId: optional(source.EXTERNAL_CONVERSATION_BOT_ID),
    externalConversationJudgeProvider: optional(source.EXTERNAL_CONVERSATION_JUDGE_PROVIDER),
    externalConversationJudgeModel: optional(source.EXTERNAL_CONVERSATION_JUDGE_MODEL),
    defaultProvider: deploymentModel.provider,
    defaultModel: deploymentModel.model,
    wakeupDriver: source.WAKEUP_DRIVER ?? "graphile",
    mcpStdioEnabled: source.MCP_STDIO_ENABLED === "true",
    mcpStdioAllowedCommands: (source.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    mcpStdio: mcpStdioOptionsFromEnv(source),
    mcpAllowPrivateEndpoint: source.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    port: Number(source.API_PORT ?? 3100),
    gitSha: optional(source.GIT_SHA) ?? optional(source.RAKAZO_GIT_SHA),
    minimumClientBuilds: parseMinimumClientBuilds(source.RAKAZO_MIN_CLIENT_BUILD),
  };
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
