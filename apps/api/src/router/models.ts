import { ORPCError } from "@orpc/server";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  buildModelConnectPlaintext,
  codexLiveListsModel,
  compatibleThinkingLevels,
  defaultCatalogModelId,
  findConnectedModelCredential,
  listPiCatalog,
  modelCredentialDto,
  parseModelSecret,
  prepareAllowedThinkingLevels as prepareModelThinkingLevels,
  prepareStoredModelAuth,
  probeCatalogProviderModels,
  probeOpenAiCompatibleModels,
  providerCatalogCache,
  scriptedCatalogEntry,
  selectDefaultCredentialId,
  serializeModelSecret,
  storedOpenAiCompatibleProbeKey,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  storedPiProviderIds,
  usableModelId,
} from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  comparePreferenceOrder,
  defaultModelCredentialCandidates,
  deleteUnreferencedCredentialSecret,
  findModelCredential,
  listSpaceBackupModels,
  modelCredentialProviderFilter,
  newestModelCredentialOrder,
  Prisma,
  replaceSpaceBackupModels,
  runAsSystem,
  selectSpaceModelPreference,
} from "@rakazo/db";
import { withSerializableRetry } from "../serializable-retry.js";
import type { RouterContext, RouterDeps } from "./shared.js";
import { authed, mayUsePrivateEndpoint } from "./shared.js";

function prepareAllowedThinkingLevels(
  deps: RouterDeps,
  actor: Actor,
  provider: string,
  modelId: string,
) {
  return prepareModelThinkingLevels(
    { prisma: deps.prisma, secretStore: deps.secrets },
    actor,
    provider,
    modelId,
  );
}

async function allowedThinkingLevels(
  ...args: Parameters<typeof prepareAllowedThinkingLevels>
): Promise<string[] | undefined> {
  return (await prepareAllowedThinkingLevels(...args)).allowed;
}

async function persistModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    label?: string;
    modelId?: string;
    thinkingLevel?: string | null;
    supportsImages?: boolean;
    signal?: AbortSignal;
  },
  codexCatalog: CodexLiveCatalog,
) {
  throwIfAborted(input.signal);
  const requestedModelId = usableModelId(input.modelId);
  const authError = requestedModelId
    ? validateModelAuthAvailability(input.provider, requestedModelId, input.plaintext)
    : undefined;
  // The backend's live catalog can clear a static OAuth exclusion for the
  // account this credential signs into (e.g. Codex Spark on ChatGPT plans).
  if (
    authError &&
    requestedModelId &&
    !(await codexLiveListsModel(
      codexCatalog,
      actor.userId,
      parseModelSecret(input.plaintext),
      requestedModelId,
    ))
  ) {
    throw new ORPCError("BAD_REQUEST", { message: authError });
  }
  const defaultModel =
    requestedModelId ??
    defaultCatalogModelId(input.provider, input.plaintext) ??
    usableModelId(deps.env.defaultModel);
  // A compatible connect may enable its new default, so judge it by the secret being saved.
  const allowedThinking = !defaultModel
    ? undefined
    : input.provider === OPENAI_COMPATIBLE_PROVIDER_ID
      ? compatibleThinkingLevels(
          { id: "", provider: input.provider, label: "", isDefault: true, defaultModel },
          input.plaintext,
          defaultModel,
        ).allowed
      : await allowedThinkingLevels(deps, actor, input.provider, defaultModel);
  const stored = await deps.secrets.put(input.plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  throwIfAborted(input.signal);
  const cred = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        throwIfAborted(input.signal);
        const existing = await tx.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: { in: storedPiProviderIds(input.provider) } },
          orderBy: newestModelCredentialOrder,
        });
        throwIfAborted(input.signal);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "model",
            ciphertext: stored.ciphertext,
          },
        });
        throwIfAborted(input.signal);
        const credential = !existing
          ? await tx.userModelCredential.create({
              data: {
                userId: actor.userId,
                provider: input.provider,
                label: input.label ?? input.provider,
                secretId: secret.id,
                supportsImages: input.supportsImages ?? false,
              },
            })
          : await tx.userModelCredential.update({
              where: { id: existing.id },
              data: {
                label: input.label ?? input.provider,
                secretId: secret.id,
                ...(input.supportsImages !== undefined
                  ? { supportsImages: input.supportsImages }
                  : {}),
              },
            });
        throwIfAborted(input.signal);
        let thinkingLevel = input.thinkingLevel;
        if (thinkingLevel === undefined) {
          // A stored effort only carries over while it still names this model.
          const previous = await tx.spaceModelPreference.findFirst({
            where: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              credentialId: credential.id,
            },
            select: { modelId: true, thinkingLevel: true },
          });
          thinkingLevel =
            previous?.modelId === usableModelId(defaultModel) ? previous.thinkingLevel : null;
        }
        // Connect and limit saves can still carry an effort chosen for the previous
        // model. Keep it only when this model supports it; otherwise clamp or clear.
        thinkingLevel = defaultModel
          ? clampCatalogThinkingLevel(thinkingLevel, allowedThinking)
          : null;
        await selectSpaceModelPreference(tx, actor, credential.id, defaultModel, thinkingLevel);
        throwIfAborted(input.signal);
        if (existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialId: existing.id,
            secretId: existing.secretId,
          });
          throwIfAborted(input.signal);
        }
        return { ...credential, isDefault: true, defaultModel };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  (deps.providerCatalog ?? providerCatalogCache).invalidate(canonicalPiProviderId(input.provider));
  return modelCredentialDto(cred, input.plaintext);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
}

/** The actor's active compatible bot, routine and backup pins matching `filter`. */
async function compatibleModelPins(
  deps: RouterDeps,
  actor: Actor,
  filter: { spaceId?: string; modelId: string | { notIn: string[] } },
) {
  const provider = OPENAI_COMPATIBLE_PROVIDER_ID;
  const where = { userId: actor.userId, ...filter };
  const pin = { spaceId: true, modelId: true } as const;
  // A connection is the account's, so its pins are checked in every Space it is used in.
  const [bots, routines, backups] = await runAsSystem(
    "model pins across the account's Spaces",
    () =>
      Promise.all([
        deps.prisma.bot.findMany({
          where: { ...where, archivedAt: null, modelProvider: provider },
          select: { ...pin, name: true },
        }),
        deps.prisma.routine.findMany({
          where: { ...where, modelProvider: provider, bot: { archivedAt: null } },
          select: { ...pin, name: true },
        }),
        deps.prisma.spaceBackupModel.findMany({ where: { ...where, provider }, select: pin }),
      ]),
  );
  return { named: [...bots, ...routines], backups };
}

type ModelPinRow = { spaceId: string; modelId: string | null };

/** Refusal naming the bots and routines (plus "backup models") left on a dropped model. */
function refuseModelPins(
  pins: { named: Array<ModelPinRow & { name: string }>; backups: ModelPinRow[] },
  dangling: (row: ModelPinRow) => boolean,
) {
  const names = pins.named.filter(dangling).map((row) => row.name);
  if (pins.backups.some(dangling)) names.push("backup models");
  if (names.length === 0) return;
  throw new ORPCError("BAD_REQUEST", {
    message: `In use by ${[...new Set(names)].join(", ")}. Pick another model for them first.`,
  });
}

/** Refuse only pins that runtime selection cannot serve after this connection save. */
async function assertNoDanglingModelPins(
  deps: RouterDeps,
  actor: Actor,
  secret: ReturnType<typeof parseModelSecret>,
  actorDefault: string,
) {
  const stored = secret.kind === "openai_compatible" ? (secret.enabledModelIds ?? []) : [];
  const [connection, preferences, pins] = await Promise.all([
    deps.prisma.userModelCredential.findFirst({
      where: { userId: actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      orderBy: newestModelCredentialOrder,
    }),
    deps.prisma.spaceModelPreference.findMany({
      where: {
        userId: actor.userId,
        credential: { userId: actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      },
      select: { spaceId: true, modelId: true, credentialId: true },
    }),
    compatibleModelPins(deps, actor, { modelId: { notIn: stored } }),
  ]);
  if (!connection) return;
  const defaults = new Map(
    preferences
      .filter((row) => row.credentialId === connection.id)
      .map((row) => [row.spaceId, usableModelId(row.modelId)]),
  );
  defaults.set(actor.spaceId, usableModelId(actorDefault));
  const dangling = new Set<ModelPinRow>();
  for (const row of [...pins.named, ...pins.backups]) {
    if (!row.modelId || row.modelId === defaults.get(row.spaceId)) continue;
    const selected = await findConnectedModelCredential(
      deps.prisma,
      deps.secrets,
      { ...actor, spaceId: row.spaceId },
      OPENAI_COMPATIBLE_PROVIDER_ID,
      row.modelId,
      {
        replacement: {
          credentialId: connection.id,
          secret,
          defaultModel: defaults.get(row.spaceId) ?? null,
        },
      },
    );
    if (selected?.id === connection.id || !selected) dangling.add(row);
  }
  refuseModelPins(pins, (row) => dangling.has(row));
}

/**
 * `models.setDefault` on an openai-compatible connection: a listed secret only accepts an
 * effective id. It changes only this space's default and never the secret, so the only pins
 * it can strand are this space's pins on an outgoing default that is outside the stored list.
 */
async function assertCompatibleDefaultChange(
  deps: RouterDeps,
  actor: Actor,
  modelId: string,
  thinking: { enabledModelIds?: string[]; storedEnabledModelIds?: string[] },
) {
  const requested = modelId.trim();
  const enabled = thinking.enabledModelIds ?? [];
  const stored = thinking.storedEnabledModelIds;
  if (stored && !enabled.includes(requested)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that provider" });
  }
  const outgoing = enabled.find((id) => id !== requested && !stored?.includes(id));
  if (!outgoing) return;
  const pins = await compatibleModelPins(deps, actor, {
    spaceId: actor.spaceId,
    modelId: outgoing,
  });
  refuseModelPins(pins, () => true);
}

export function modelsRouter(ctx: RouterContext) {
  const { deps, codexCatalog, refreshExpiredCredential, catalogForSpace } = ctx;
  return {
    models: {
      list: authed.models.list.handler(async ({ context }) => {
        const catalog = await catalogForSpace(context.actor);
        // The scripted fixture only exists to drive the scripted runtime; a real
        // runtime cannot execute it, so it stays out of the user-facing catalog.
        return deps.env.agentRuntime === "scripted" ? [...catalog, scriptedCatalogEntry] : catalog;
      }),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userModelCredential.findMany({
          where: { userId: context.actor.userId },
          include: {
            preferences: {
              where: { userId: context.actor.userId, spaceId: context.actor.spaceId },
            },
          },
          orderBy: newestModelCredentialOrder,
        });
        const secrets = rows.length
          ? await deps.prisma.secret.findMany({
              where: {
                id: { in: rows.map((row) => row.secretId) },
                userId: context.actor.userId,
                spaceId: null,
              },
              select: { id: true, ciphertext: true },
            })
          : [];
        const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
        const preferenceRanks = new Map(
          rows
            .flatMap((row) => row.preferences)
            .sort(comparePreferenceOrder)
            .map((preference, index) => [preference.id, index]),
        );
        return Promise.all(
          rows.map(async (row) => {
            const preference = row.preferences[0];
            const selected = {
              ...row,
              isDefault: preference?.isDefault ?? false,
              defaultModel: preference?.modelId ?? null,
              thinkingLevel: preference?.thinkingLevel ?? null,
            };
            const dto = (plaintext?: string) => ({
              ...modelCredentialDto(selected, plaintext),
              ...(preference ? { preferenceRank: preferenceRanks.get(preference.id) } : {}),
            });
            const ciphertext = ciphertextById.get(row.secretId);
            if (!ciphertext) return dto();
            try {
              return dto(await deps.secrets.load(ciphertext, row.secretId));
            } catch (error) {
              if (error instanceof SecretStoreUnavailableError)
                throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
              return dto();
            }
          }),
        );
      }),
      backups: authed.models.backups.handler(async ({ context }) =>
        listSpaceBackupModels(deps.prisma, context.actor),
      ),
      setBackups: authed.models.setBackups.handler(async ({ context, input }) => {
        if (input.length > 0) {
          const catalog = await catalogForSpace(context.actor);
          for (const choice of input) {
            const credential = await findModelCredential(
              deps.prisma,
              context.actor,
              choice.provider,
              choice.modelId,
            );
            if (!credential) {
              throw new ORPCError("BAD_REQUEST", {
                message: "Connect that model provider first",
              });
            }
            if (
              choice.provider !== OPENAI_COMPATIBLE_PROVIDER_ID &&
              catalog.some(
                (entry) =>
                  entry.provider === canonicalPiProviderId(choice.provider) &&
                  entry.id === choice.modelId,
              )
            )
              continue;
            const error = await validateConnectedModelChoice(
              deps.prisma,
              deps.secrets,
              context.actor,
              choice.provider,
              choice.modelId,
            );
            if (error || choice.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
              throw new ORPCError("BAD_REQUEST", {
                message: error ?? "That model is not available for this connection",
              });
            }
          }
        }
        await replaceSpaceBackupModels(deps.prisma, context.actor, input);
        return { ok: true as const };
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        let plaintext: string;
        try {
          let previousPlaintext: string | undefined;
          let omitVisionModelIds = false;
          const credential = await findModelCredential(deps.prisma, context.actor, input.provider);
          if (credential) {
            const secret = await deps.prisma.secret.findFirst({
              where: { id: credential.secretId, userId: context.actor.userId, spaceId: null },
              select: { ciphertext: true },
            });
            if (secret) {
              try {
                previousPlaintext = await deps.secrets.load(secret.ciphertext, credential.secretId);
              } catch (error) {
                // Explicit key replacement must still succeed when the prior
                // ciphertext is unreadable. For OpenAI-compatible connections,
                // omit visionModelIds so a partial one-model list does not wipe
                // other enabled models; DB supportsImages + defaultModel remain
                // the legacy fallback.
                if (input.apiKey === undefined) throw error;
                if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
                  omitVisionModelIds = true;
                }
              }
            }
          }
          plaintext = buildModelConnectPlaintext(input, previousPlaintext, {
            omitVisionModelIds,
            allowPrivateEndpoint: mayUsePrivateEndpoint(context.actor, deps),
          });
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Invalid model connection",
          });
        }
        if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
          // Limits: this runs before persistModelCredential's transaction. A pin saved in
          // between can fall outside the stored list and then fails at run time with
          // "Unknown model for that provider". Closing it needs every pin write (bots,
          // routines, backups) serializable. Concurrent saves of the same connection are
          // last-write-wins, as before this list existed, so one save's ticks can be dropped.
          const saved = parseModelSecret(plaintext);
          await assertNoDanglingModelPins(deps, context.actor, saved, input.modelId ?? "");
        }
        return persistModelCredential(
          deps,
          context.actor,
          {
            provider: input.provider,
            plaintext,
            label: input.label,
            modelId: input.modelId,
            // openai-compatible keeps its effort inside the stored endpoint
            // secret; catalog providers store it on the space preference.
            thinkingLevel:
              input.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? undefined : input.thinkingLevel,
            supportsImages: input.supportsImages,
            signal: context.signal,
          },
          codexCatalog,
        );
      }),
      probeOpenAiCompatible: authed.models.probeOpenAiCompatible.handler(
        async ({ context, input }) => {
          let apiKey = input.apiKey;
          if (!apiKey?.trim()) {
            try {
              const preferred = await findModelCredential(
                deps.prisma,
                context.actor,
                OPENAI_COMPATIBLE_PROVIDER_ID,
              );
              const credentials = await deps.prisma.userModelCredential.findMany({
                where: { userId: context.actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              });
              const candidates = preferred
                ? [preferred, ...credentials.filter((credential) => credential.id !== preferred.id)]
                : credentials;
              const secrets = await deps.prisma.secret.findMany({
                where: {
                  id: { in: candidates.map((credential) => credential.secretId) },
                  userId: context.actor.userId,
                  spaceId: null,
                },
                select: { id: true, ciphertext: true },
              });
              const ciphertexts = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
              for (const credential of candidates) {
                const ciphertext = ciphertexts.get(credential.secretId);
                if (!ciphertext) continue;
                try {
                  apiKey = storedOpenAiCompatibleProbeKey(
                    input.baseUrl,
                    await deps.secrets.load(ciphertext, credential.secretId),
                  );
                  if (apiKey) break;
                } catch {
                  // An unreadable secret must not prevent trying the remaining credentials.
                }
              }
            } catch {
              // An unavailable saved key must not prevent a keyless probe.
            }
          }
          try {
            const models = await probeOpenAiCompatibleModels(
              { ...input, apiKey },
              undefined,
              context.signal,
              { allowPrivate: mayUsePrivateEndpoint(context.actor, deps) },
            );
            return { models };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not list models",
            });
          }
        },
      ),
      probeCatalog: authed.models.probeCatalog.handler(async ({ context, input }) => {
        try {
          const models = await probeCatalogProviderModels(
            { provider: input.provider, apiKey: input.apiKey },
            undefined,
            context.signal,
          );
          return { models };
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Could not list models",
          });
        }
      }),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        return deps.oauthLogins.begin({
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          provider: input.provider,
          modelId: input.modelId,
          thinkingLevel: input.thinkingLevel,
          label: input.label,
          signal: context.signal,
        });
      }),
      submitOAuthCode: authed.models.submitOAuthCode.handler(async ({ context, input }) => {
        return deps.oauthLogins.submit(input.loginId, context.actor, input.code);
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        const result = await deps.oauthLogins.complete(input.loginId, {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
        });
        return result.status === "connected" ? { status: "ready" as const } : result;
      }),
      finishOAuth: authed.models.finishOAuth.handler(async ({ context, input }) => {
        throwIfAborted(context.signal);
        const result = await deps.oauthLogins.finish(
          input.loginId,
          context.actor,
          async (login) => {
            return persistModelCredential(
              deps,
              context.actor,
              {
                provider: login.provider,
                plaintext: serializeModelSecret({ kind: "oauth", credential: login.credential }),
                label:
                  login.label ??
                  listPiCatalog().find((entry) => entry.provider === login.provider)?.providerName,
                modelId: login.modelId,
                thinkingLevel: login.thinkingLevel,
                signal: login.signal,
              },
              codexCatalog,
            );
          },
        );
        if (result.status === "pending") {
          throw new ORPCError("CONFLICT", { message: "Sign-in has not finished yet." });
        }
        if (result.status === "error") {
          throw new ORPCError("NOT_FOUND", { message: result.error });
        }
        return result.value;
      }),
      cancelOAuth: authed.models.cancelOAuth.handler(async ({ context, input }) => {
        await deps.oauthLogins.cancel(input.loginId, context.actor);
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        const loadSpaceModelState = async (
          client: Pick<PrismaClient, "spaceModelPreference" | "userModelCredential">,
        ) => {
          const [preferences, credentials] = await Promise.all([
            client.spaceModelPreference.findMany({
              where: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                credential: { provider: modelCredentialProviderFilter(input.provider) },
              },
              include: { credential: true },
            }),
            client.userModelCredential.findMany({
              where: {
                userId: context.actor.userId,
                provider: modelCredentialProviderFilter(input.provider),
              },
            }),
          ]);
          return {
            preferences,
            candidates: defaultModelCredentialCandidates({
              provider: input.provider,
              modelId: input.modelId,
              preferences,
              credentials,
            }),
          };
        };
        await withSerializableRetry(async () => {
          const preparedState = await loadSpaceModelState(deps.prisma);
          const preparedAuth = new Map(
            await Promise.all(
              preparedState.candidates.map(
                async (candidate) =>
                  [
                    candidate.secretId,
                    await prepareStoredModelAuth(
                      deps.prisma,
                      deps.secrets,
                      context.actor.userId,
                      candidate.secretId,
                      input.provider,
                      input.modelId,
                      codexCatalog,
                      {
                        onExpiredToken: () =>
                          refreshExpiredCredential(
                            context.actor,
                            candidate.secretId,
                            input.provider,
                          ),
                      },
                    ),
                  ] as const,
              ),
            ),
          );
          const needsThinking =
            input.thinkingLevel === undefined
              ? preparedState.preferences.some(
                  (preference) =>
                    preference.modelId === usableModelId(input.modelId) &&
                    Boolean(preference.thinkingLevel),
                )
              : Boolean(input.thinkingLevel);
          const compatible = input.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
          // Compatible defaults always load the secret so the transaction rechecks it.
          const thinking =
            needsThinking || compatible
              ? await prepareAllowedThinkingLevels(
                  deps,
                  context.actor,
                  input.provider,
                  input.modelId,
                )
              : { allowed: undefined, secret: undefined };
          if (compatible) {
            await assertCompatibleDefaultChange(deps, context.actor, input.modelId, thinking);
          }
          return deps.prisma.$transaction(
            async (tx) => {
              const { preferences, candidates } = await loadSpaceModelState(tx);
              if (candidates.length === 0) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider}.`,
                });
              }
              if (thinking.secret) {
                const current = await tx.secret.findFirst({
                  where: { id: thinking.secret.id, userId: context.actor.userId, spaceId: null },
                  select: { ciphertext: true },
                });
                if (current?.ciphertext !== thinking.secret.ciphertext) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
              }
              const savedModelId = new Map(
                preferences.map((preference) => [preference.credential.id, preference.modelId]),
              );
              const readyIds: string[] = [];
              let authFailure: string | undefined;
              let sawReadable = false;
              for (const candidate of candidates) {
                const prepared = preparedAuth.get(candidate.secretId);
                const current = await tx.secret.findFirst({
                  where: { id: candidate.secretId, userId: context.actor.userId, spaceId: null },
                  select: { id: true, ciphertext: true },
                });
                if (!prepared || (current?.ciphertext ?? null) !== prepared.ref) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
                const auth = prepared.auth;
                if (auth.status === "unreadable") continue;
                sawReadable = true;
                if (auth.status === "rejected") {
                  authFailure ??= auth.message;
                  continue;
                }
                // The enabled-list check and execution must use the same connection.
                if (compatible && thinking.secret && candidate.secretId !== thinking.secret.id)
                  continue;
                readyIds.push(candidate.id);
              }
              const chosenId = selectDefaultCredentialId({
                provider: input.provider,
                modelId: input.modelId,
                orderedIds: candidates.map((candidate) => candidate.id),
                readyIds,
                savedModelId: (credentialId) => savedModelId.get(credentialId),
              });
              const fallbackId = !sawReadable ? candidates[0]?.id : undefined;
              const credentialId = chosenId ?? fallbackId;
              if (!credentialId) {
                throw new ORPCError("BAD_REQUEST", {
                  message: authFailure ?? UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
                });
              }
              let thinkingLevel: string | null | undefined = input.thinkingLevel;
              if (thinkingLevel === undefined) {
                // The level belongs to the preference's modelId — keep it only when the
                // stored choice already names this model.
                const existing = preferences.find(
                  (preference) => preference.credential.id === credentialId,
                );
                thinkingLevel =
                  existing?.modelId === usableModelId(input.modelId)
                    ? existing.thinkingLevel
                    : null;
              }
              if (thinkingLevel) {
                if (!needsThinking) {
                  throw new ORPCError("CONFLICT", { message: "Model preferences changed; retry." });
                }
                thinkingLevel = clampCatalogThinkingLevel(thinkingLevel, thinking.allowed);
              }
              await selectSpaceModelPreference(
                tx,
                context.actor,
                credentialId,
                input.modelId,
                thinkingLevel,
              );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        }).catch((error: unknown) => {
          if (error instanceof SecretStoreUnavailableError)
            throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
          throw error;
        });
        return { ok: true as const };
      }),
      disconnect: authed.models.disconnect.handler(async ({ context, input }) => {
        // Retire pending sign-ins in every space first — the credentials are
        // account-wide, so a finishing OAuth session anywhere could otherwise
        // re-persist a credential the delete below just removed.
        await deps.oauthLogins.cancelProvider({
          userId: context.actor.userId,
          provider: input.provider,
        });
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              await tx.spaceBackupModel.deleteMany({
                where: {
                  userId: context.actor.userId,
                  provider: modelCredentialProviderFilter(input.provider),
                },
              });
              const existing = await tx.userModelCredential.findMany({
                where: {
                  userId: context.actor.userId,
                  provider: modelCredentialProviderFilter(input.provider),
                },
              });
              if (existing.length === 0) return;
              const ids = existing.map((row) => row.id);
              // Credentials belong to the account, not the space — disconnecting
              // removes them everywhere, matching voice.disconnect. Linked
              // preferences in other spaces go with their credential.
              await tx.spaceModelPreference.deleteMany({
                where: { userId: context.actor.userId, credentialId: { in: ids } },
              });
              await tx.userModelCredential.deleteMany({
                where: { userId: context.actor.userId, id: { in: ids } },
              });
              for (const row of existing) {
                await deleteUnreferencedCredentialSecret(tx, {
                  credentialId: row.id,
                  secretId: row.secretId,
                });
              }
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        (deps.providerCatalog ?? providerCatalogCache).invalidate(
          canonicalPiProviderId(input.provider),
        );
        return { ok: true as const };
      }),
    },
  };
}
