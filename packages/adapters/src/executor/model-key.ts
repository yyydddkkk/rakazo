import type {
  AgentModelOAuthCredential,
  AgentRunRequest,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
} from "@rakazo/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { retireModelCredential } from "@rakazo/db";
import { resolveDeploymentModel } from "../deployment-model.js";
import {
  enabledOpenAiCompatibleModelIds,
  UnavailableModelForAuthError,
  validateModelAuthAvailability,
} from "../model-selection.js";
import { modelIdSupportsImages } from "../model-vision.js";
import { assertAllowedOpenAiCompatibleUrl } from "../openai-compatible-url.js";
import { codexLiveListsModel } from "../pi-codex-catalog.js";
import { toOAuthCredential } from "../pi-credentials.js";
import type { StoredModelSecret } from "../pi-oauth.js";
import {
  matchesFailedOAuthSecret,
  parseModelSecret,
  persistStoredModelSecret,
  resolveModelAuth,
  secretValuesToRedact,
  serializeModelSecret,
  withModelCredentialLock,
} from "../pi-oauth.js";
import { actorMayUsePrivateEndpoint } from "../private-endpoint.js";
import type { ExecutorDeps } from "./deps.js";

/**
 * The deployment key is a bearer credential for exactly one vendor, so it is handed out
 * only when the provider that won the resolution above is that vendor. A provider named
 * by deployment settings or a bot override gets no key rather than another vendor's.
 */
function deploymentKeyFor(deps: ExecutorDeps, provider: string): string | undefined {
  if (!deps.deploymentModelKey) return undefined;
  return provider === resolveDeploymentModel().provider ? deps.deploymentModelKey : undefined;
}

/**
 * A run can afford a longer catalog wait than the models.list read bound — the
 * account answer decides whether a statically excluded model is allowed at all.
 * Still bounded well under the fetch's own abort timeout.
 */
const CODEX_LIVE_RUN_WAIT_MS = 8_000;

// Listed connections serve enabled ids and their space default; legacy connections serve any id.
function assertCompatibleModelEnabled(
  credential: { provider: string; defaultModel?: string | null },
  secret: StoredModelSecret,
  modelId: string,
) {
  if (credential.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) return;
  if (secret.kind !== "openai_compatible") return;
  if (secret.enabledModelIds !== undefined) {
    if (!enabledOpenAiCompatibleModelIds(secret, credential.defaultModel).includes(modelId)) {
      throw new UnavailableModelForAuthError("Unknown model for that provider");
    }
    return;
  }
}

export async function resolveModelKey(
  deps: ExecutorDeps,
  userId: string,
  spaceId: string,
  credential: {
    id: string;
    secretId: string;
    provider: string;
    defaultModel?: string | null;
    supportsImages?: boolean;
  } | null,
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  { requireStoredSecret = false }: { requireStoredSecret?: boolean } = {},
): Promise<{
  apiKey?: string;
  baseUrl?: string;
  allowPrivateEndpoint?: boolean;
  cacheCapabilities?: AgentRunRequest["model"]["cacheCapabilities"];
  contextWindow?: number;
  reasoning?: boolean;
  maxTokens?: number;
  thinkingLevel?: AgentRunRequest["model"]["thinkingLevel"];
  acceptsImages?: boolean;
  maxImagesPerPrompt?: number;
  oauth?: AgentModelOAuthCredential;
  persistOAuth?: (credential: AgentModelOAuthCredential) => Promise<void>;
  retireOAuth?: (
    reason: ModelCredentialRetireReason,
    detail?: string,
    failed?: ModelCredentialFailedState,
  ) => Promise<boolean | undefined>;
  redact: string[];
}> {
  if (credential) {
    return withModelCredentialLock(credential.secretId, async () => {
      const row = await deps.prisma.secret.findFirst({
        where: { id: credential.secretId, userId, spaceId: null },
      });
      if (!row) {
        if (requireStoredSecret) throw new Error("Backup model credential is no longer available");
        if (credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
          throw new UnavailableModelForAuthError("Unknown model for that provider");
        }
        return { apiKey: deploymentKeyFor(deps, provider), redact: [] };
      }
      const plaintext = await deps.secretStore.load(row.ciphertext, row.id);
      registerSecrets?.(secretValuesToRedact(parseModelSecret(plaintext)));
      const persist = persistStoredModelSecret(
        deps.prisma,
        deps.secretStore,
        { userId, spaceId },
        row.id,
      );
      // Retire exactly this credential. Two fences keep a stale failure from
      // deleting newer material: secretId guards a reconnect that swapped the
      // secret row, and matchesFailedSecret guards a concurrent successful
      // refresh that rewrote the same row's ciphertext in place.
      const retire = (
        _reason: ModelCredentialRetireReason,
        _detail: string | undefined,
        failed?: ModelCredentialFailedState,
      ) =>
        retireModelCredential(deps.prisma, {
          userId,
          credentialId: credential.id,
          secretId: credential.secretId,
          matchesFailedSecret: failed
            ? matchesFailedOAuthSecret(
                (ciphertext, secretId) => deps.secretStore.load(ciphertext, secretId),
                failed,
              )
            : undefined,
        });
      const resolveAuth = () =>
        resolveModelAuth(plaintext, credential.provider, { persist, retire });
      let resolved: Awaited<ReturnType<typeof resolveAuth>> | undefined;
      const authError = validateModelAuthAvailability(provider, modelId, plaintext);
      if (authError) {
        // A statically excluded Codex model may still run when the backend's
        // per-account catalog lists it for this credential. The catalog path
        // never refreshes or writes credentials, so resolve inside this lock
        // first — rotating a stale token the way any run would — then ask.
        let liveListed = false;
        if (deps.codexCatalog && parseModelSecret(plaintext).kind === "oauth") {
          resolved = await resolveAuth();
          liveListed = await codexLiveListsModel(
            deps.codexCatalog,
            userId,
            resolved.secret,
            modelId,
            { waitMs: CODEX_LIVE_RUN_WAIT_MS },
          );
        }
        if (!liveListed) throw new UnavailableModelForAuthError(authError);
      }
      resolved ??= await resolveAuth();
      assertCompatibleModelEnabled(credential, resolved.secret, modelId);
      const oauth = resolved.secret.kind === "oauth" ? resolved.secret.credential : undefined;
      const baseUrl =
        resolved.secret.kind === "openai_compatible" ? resolved.secret.baseUrl : undefined;
      // Connections saved before the owner gate may already point at private hosts,
      // so decide for the credential's owner on every run, not only on save.
      const allowPrivateEndpoint = baseUrl
        ? await actorMayUsePrivateEndpoint(
            deps.prisma,
            userId,
            deps.mcpAllowPrivateEndpoint === true,
          )
        : undefined;
      if (baseUrl) {
        try {
          // The public gate stays with the request-time fetch guard.
          assertAllowedOpenAiCompatibleUrl(baseUrl, {
            allowPublic: true,
            allowPrivate: allowPrivateEndpoint,
          });
        } catch (error) {
          throw new UnavailableModelForAuthError((error as Error).message);
        }
      }
      const acceptsImages =
        credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
        resolved.secret.kind === "openai_compatible" &&
        (modelIdSupportsImages(resolved.secret.visionModelIds, modelId) ||
          // Legacy secrets have no per-model list, so keep their existing
          // capability scoped to the model saved in the space preference.
          (resolved.secret.visionModelIds === undefined &&
            credential.supportsImages === true &&
            credential.defaultModel?.trim() === modelId.trim()));
      return {
        apiKey: resolved.apiKey,
        baseUrl,
        allowPrivateEndpoint,
        cacheCapabilities:
          resolved.secret.kind !== "oauth" ? resolved.secret.cacheCapabilities : undefined,
        contextWindow: resolved.secret.kind !== "oauth" ? resolved.secret.contextWindow : undefined,
        reasoning:
          resolved.secret.kind === "openai_compatible" ? resolved.secret.reasoning : undefined,
        maxTokens: resolved.secret.maxTokens,
        thinkingLevel:
          resolved.secret.kind === "openai_compatible" ? resolved.secret.thinkingLevel : undefined,
        acceptsImages,
        maxImagesPerPrompt:
          resolved.secret.kind === "openai_compatible"
            ? resolved.secret.maxImagesPerPrompt
            : undefined,
        oauth,
        persistOAuth: oauth
          ? async (next) => {
              await withModelCredentialLock(credential.secretId, async () => {
                const currentRow = await deps.prisma.secret.findFirst({
                  where: { id: credential.secretId, userId, spaceId: null },
                });
                if (!currentRow) return;
                const current = parseModelSecret(
                  await deps.secretStore.load(currentRow.ciphertext, currentRow.id),
                );
                if (current.kind === "oauth") {
                  const stored = current.credential;
                  if (stored.expires > next.expires) return;
                  if (
                    stored.access === next.access &&
                    stored.refresh === next.refresh &&
                    stored.expires === next.expires
                  ) {
                    return;
                  }
                }
                await persist(
                  serializeModelSecret({
                    kind: "oauth",
                    credential: toOAuthCredential(next),
                    ...(current.maxTokens !== undefined ? { maxTokens: current.maxTokens } : {}),
                  }),
                );
              });
            }
          : undefined,
        retireOAuth: retire,
        redact: [...secretValuesToRedact(resolved.secret), resolved.apiKey].filter(
          (value): value is string => Boolean(value),
        ),
      };
    });
  }
  if (requireStoredSecret) throw new Error("Backup model credential is no longer available");
  return { apiKey: deploymentKeyFor(deps, provider), redact: [] };
}
