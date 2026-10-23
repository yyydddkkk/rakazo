import { ORPCError } from "@orpc/server";
import type { AdapterContext, ConnectorCatalogItem } from "@rakazo/adapter-kit";
import {
  pickReusableConnection,
  planLiveConnectionSync,
  sanitizeConnectorError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, type Prisma, runAsSystemInTransaction } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RouterContext } from "./shared.js";
import { authed } from "./shared.js";

async function reconcileConnections(
  prisma: PrismaClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
  reconnectRefs: string[],
): Promise<void> {
  const connectedProviderKeys = new Set(
    connectedProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const rows = (
    await prisma.connection.findMany({
      where: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId,
        status: { in: ["pending", "connected"] },
      },
      select: { id: true, provider: true, displayName: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((row: { provider: string }) =>
    connectedProviderKeys.has(row.provider.trim().toLowerCase()),
  );
  const sync = planLiveConnectionSync(rows, connectedProviders);
  const updates = [
    ...sync.connectIds.map((id) => async (tx: Prisma.TransactionClient) => {
      await tx.connection.updateMany({
        where: { id, spaceId: owner.spaceId, userId: owner.userId, status: "pending" },
        data: { status: "connected" },
      });
    }),
    ...(sync.revokeIds.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                id: { in: sync.revokeIds },
                spaceId: owner.spaceId,
                userId: owner.userId,
                status: "pending",
              },
              data: { status: "revoked" },
            }),
        ]
      : []),
    // The provider reports these accounts dead, so the app offers to connect them again.
    ...(reconnectRefs.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                spaceId: owner.spaceId,
                userId: owner.userId,
                connectorId,
                status: "connected",
                providerRef: { in: reconnectRefs },
              },
              data: { status: "error" },
            }),
        ]
      : []),
  ];
  // Interactive rather than a batch: a batch cannot carry the request's database context.
  if (updates.length > 0)
    await prisma.$transaction(async (tx) => {
      for (const update of updates) await update(tx);
    });
}

/** Serialize begin/revoke for one user+provider so slug-wide remote deletes cannot race a new connect. */

function isAmbiguousRemoteRevokeFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|network|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message);
}

/** True when a connector failed before issuing any remote DELETE. */
function isRemoteRevokePreDeleteFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "remoteRevokePreDelete" in error &&
      (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete === true,
  );
}

function shouldRestoreLocalAfterRemoteRevokeFailure(error: unknown): boolean {
  // Pre-delete list/network failures never reached DELETE — always keep retry state.
  // Post-delete timeouts stay ambiguous and leave the row revoked.
  return isRemoteRevokePreDeleteFailure(error) || !isAmbiguousRemoteRevokeFailure(error);
}

/**
 * Concrete account ids still referenced by active local rows. When any row still
 * only has the provider slug (or no ref), orphan cleanup must not run — a sibling
 * may have created its remote account before persisting the concrete id.
 */
function concreteKeepAccountIds(
  refs: Array<string | null | undefined>,
  provider: string,
): { keepIds: string[]; canRevokeUnreferenced: boolean } {
  const keepIds: string[] = [];
  let canRevokeUnreferenced = true;
  for (const ref of refs) {
    const value = ref?.trim();
    if (!value || value === provider) {
      canRevokeUnreferenced = false;
      continue;
    }
    keepIds.push(value);
  }
  return { keepIds, canRevokeUnreferenced };
}

async function lockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): Promise<void> {
  // Avoid NUL separators in the lock key; text params may truncate at a zero byte and break begin.
  // Not per Space: the provider's accounts belong to the user, so Spaces serialize together.
  const scope = `user:${owner.userId}|connector:${connectorId}|provider:${provider}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connection-provider'), hashtext(${scope}))`;
}

/**
 * Account refs the user's rows in other Spaces hold for one provider. The provider's
 * accounts belong to the user, so cleanup and account matching in one Space must not
 * touch an account another Space connected.
 */
async function otherSpaceRefs(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
  statuses: string[] = ["connected", "pending", "error"],
): Promise<Array<string | null>> {
  const rows = await runAsSystemInTransaction(tx, "the account's connections in other Spaces", () =>
    tx.connection.findMany({
      where: {
        userId: owner.userId,
        spaceId: { not: owner.spaceId },
        connectorId,
        provider,
        status: { in: statuses },
      },
      select: { providerRef: true },
    }),
  );
  return rows.map((row) => row.providerRef);
}

function connectionContext(
  actor: Pick<Actor, "spaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

export function connectionsRouter(ctx: RouterContext) {
  const { deps } = ctx;
  return {
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        const adapterContext = connectionContext(
          context.actor,
          "connections.catalog",
          context.signal,
        );
        const providers = input.connectorId
          ? [deps.connectors.managed(input.connectorId)].filter(
              (provider): provider is NonNullable<typeof provider> => Boolean(provider),
            )
          : deps.connectors.managedProviders();
        const catalogs = await Promise.all(
          providers.map(async (provider): Promise<ConnectorCatalogItem[]> => {
            try {
              const [items, reconnectRefs] = await Promise.all([
                provider.catalog(adapterContext, input.query),
                provider.listReconnectRefs?.(adapterContext).catch(() => []) ?? [],
              ]);
              const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
              if (nowConnected.length > 0 || reconnectRefs.length > 0) {
                await reconcileConnections(
                  deps.prisma,
                  context.actor,
                  provider.describe().id,
                  nowConnected,
                  reconnectRefs,
                ).catch((error) => {
                  getLogger().error(
                    `${provider.describe().id} connection reconciliation failed`,
                    error,
                  );
                });
              }
              // The provider's flag is the user's; an app is added only where this Space has a row.
              const connected = await deps.prisma.connection.findMany({
                where: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  connectorId: provider.describe().id,
                  status: "connected",
                },
                select: { provider: true },
              });
              const added = new Set(connected.map((row) => row.provider.trim().toLowerCase()));
              return items.map((item) => ({
                ...item,
                connected: added.has(item.slug.trim().toLowerCase()),
              }));
            } catch {
              return [];
            }
          }),
        );
        return catalogs.flat();
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      begin: authed.connections.begin.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${input.connectorId} is not configured`,
          });
        }
        // Share the revoke scope lock so a slug-wide remote delete cannot miss a
        // row that is inserted after SELECT FOR UPDATE and before remote revoke.
        const row = await deps.prisma.$transaction(async (tx) => {
          await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
          const existing = await tx.connection.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: input.connectorId,
              provider: input.provider,
            },
            select: { id: true, status: true },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          });
          const reusable = pickReusableConnection(existing);
          if (reusable) {
            return tx.connection.update({
              where: { id: reusable.id },
              data: {
                displayName: input.displayName,
                status: "pending",
                providerRef: null,
                metadata: {},
              },
            });
          }
          return tx.connection.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: input.connectorId,
              provider: input.provider,
              displayName: input.displayName,
              status: "pending",
            },
          });
        });
        try {
          const auth = await connector.begin(
            { provider: input.provider, redirectUrl: `${deps.env.webOrigin}/app` },
            connectionContext(context.actor, "connections.begin", context.signal),
          );
          // Re-take the provider lock and only advance still-pending rows so a
          // concurrent revoke cannot be overwritten back to pending/connected.
          const applied = await deps.prisma.$transaction(async (tx) => {
            await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
            const updated = await tx.connection.updateMany({
              where: {
                id: row.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: "pending",
              },
              data: {
                status: auth.authorizationUrl ? "pending" : "connected",
                providerRef: auth.state || null,
                metadata: { state: auth.state },
              },
            });
            return updated.count > 0;
          });
          if (!applied) {
            // Revoke won the race. Clean up without a provider-wide slug delete.
            const state = auth.state?.trim();
            const adapterContext = connectionContext(
              context.actor,
              "connections.begin",
              context.signal,
            );
            if (state && state !== input.provider) {
              // Browser OAuth stores an authorization-request id in
              // auth.state. Prefer canceling that pending request by id so the
              // authorization URL cannot later create an untracked remote. The
              // request id is the connected-account nanoid (INITIATED until OAuth
              // finishes). Fall back to resolving an ACTIVE account id only when
              // cancel is unavailable.
              const cancelAuthorizationRequest = (
                connector as {
                  cancelAuthorizationRequest?: (
                    requestId: string,
                    context: typeof adapterContext,
                  ) => Promise<void>;
                }
              ).cancelAuthorizationRequest;
              if (cancelAuthorizationRequest) {
                await cancelAuthorizationRequest(state, adapterContext).catch(() => undefined);
              } else {
                const resolveAccountId = (
                  connector as {
                    resolveConnectedAccountId?: (
                      userId: string,
                      slug: string,
                      currentRef: string | null | undefined,
                      excludeIds?: string[],
                      spaceId?: string,
                    ) => Promise<string | undefined>;
                  }
                ).resolveConnectedAccountId;
                let revokeRef = state;
                if (resolveAccountId) {
                  const resolved = await resolveAccountId(
                    context.actor.userId,
                    input.provider,
                    state,
                    [],
                    context.actor.spaceId,
                  ).catch(() => undefined);
                  if (!resolved) {
                    revokeRef = "";
                  } else {
                    revokeRef = resolved;
                  }
                }
                if (revokeRef) {
                  await connector.revoke(revokeRef, adapterContext).catch(() => undefined);
                }
              }
            } else if (state === input.provider) {
              // A provider that only returns the app slug. Drop remotes that no
              // remaining local row still references so a lost race cannot leave
              // an orphan authorization, without wiping sibling accounts.
              const revokeUnreferenced = (
                connector as {
                  revokeUnreferencedAccounts?: (
                    slug: string,
                    keepAccountIds: string[],
                    context: ReturnType<typeof connectionContext>,
                  ) => Promise<void>;
                }
              ).revokeUnreferencedAccounts;
              if (revokeUnreferenced) {
                // Hold the provider lock across the keep-id snapshot and remote
                // cleanup so a concurrent complete cannot persist a providerRef
                // that this cleanup then deletes as unreferenced.
                await deps.prisma
                  .$transaction(
                    async (tx) => {
                      await lockProviderConnectionScope(
                        tx,
                        context.actor,
                        input.connectorId,
                        input.provider,
                      );
                      const kept = await tx.connection.findMany({
                        where: {
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                          connectorId: input.connectorId,
                          provider: input.provider,
                          status: { in: ["connected", "pending", "error"] },
                        },
                        select: { providerRef: true },
                      });
                      const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                        [
                          ...kept.map((entry) => entry.providerRef),
                          ...(await otherSpaceRefs(
                            tx,
                            context.actor,
                            input.connectorId,
                            input.provider,
                          )),
                        ],
                        input.provider,
                      );
                      // Skip while any sibling still lacks a concrete account id —
                      // otherwise slug-only pending refs are dropped from keepIds and
                      // revokeUnreferencedAccounts deletes that sibling's remote auth.
                      if (!canRevokeUnreferenced) return;
                      await revokeUnreferenced(input.provider, keepIds, adapterContext);
                    },
                    { timeout: 60_000 },
                  )
                  .catch(() => undefined);
              }
            }
            throw new IsolationError();
          }
          return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          await deps.prisma.connection.updateMany({
            where: {
              id: row.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              status: "pending",
            },
            data: { status: "error" },
          });
          throw new ORPCError("BAD_REQUEST", { message: sanitizeConnectorError(error) });
        }
      }),
      complete: authed.connections.complete.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const connector = deps.connectors.managed(existing.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${existing.connectorId} is not configured`,
          });
        }
        const prepared = { provider: connector };
        const transactionConnector = prepared.provider;
        if (!transactionConnector)
          throw new ORPCError("BAD_REQUEST", { message: "Integration provider is not configured" });
        let row = existing;
        let connectedNow = false;
        if (existing.status !== "connected") {
          // Hold the provider lock across remote completion, account-id resolution,
          // providerRef persistence, and any overlapping revokeUnreferenced cleanup
          // so a concurrent begin-loss cleanup cannot delete the account we are about
          // to persist.
          row = await deps.prisma.$transaction(
            async (tx) => {
              await lockProviderConnectionScope(
                tx,
                context.actor,
                existing.connectorId,
                existing.provider,
              );
              const current = await tx.connection.findFirst({
                where: {
                  id: existing.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
              if (!current) throw new IsolationError();
              if (current.status === "connected") return current;
              if (current.status === "revoked") {
                // Authorization URLs from a revoke-win begin can still finish
                // remotely. Cancel leftover pending authorization ids / drop
                // remotes no active local row still references before rejecting.
                // Not the request signal: clients abort a poll they no longer need, and
                // that must not cut short removing the leftover remote account.
                const revokedContext = connectionContext(context.actor, "connections.complete");
                const restoreRevokedForRetry = async () => {
                  // Cleanup failed while the row is already revoked — restore pending
                  // so the UI can retry removal instead of leaving an orphan remote.
                  // Use the root client (not tx): throwing below aborts this
                  // transaction and would otherwise roll back a tx-scoped restore.
                  await deps.prisma.connection.updateMany({
                    where: {
                      id: current.id,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                      status: "revoked",
                    },
                    data: { status: "pending" },
                  });
                };
                const pendingRef = current.providerRef?.trim();
                try {
                  if (pendingRef && pendingRef !== current.provider) {
                    const cancelAuthorizationRequest = (
                      transactionConnector as {
                        cancelAuthorizationRequest?: (
                          requestId: string,
                          context: typeof revokedContext,
                        ) => Promise<void>;
                      }
                    ).cancelAuthorizationRequest;
                    if (cancelAuthorizationRequest) {
                      await cancelAuthorizationRequest(pendingRef, revokedContext);
                    } else {
                      const resolveAccountId = (
                        transactionConnector as {
                          resolveConnectedAccountId?: (
                            userId: string,
                            slug: string,
                            currentRef: string | null | undefined,
                            excludeIds?: string[],
                            spaceId?: string,
                          ) => Promise<string | undefined>;
                        }
                      ).resolveConnectedAccountId;
                      let revokeRef = pendingRef;
                      if (resolveAccountId) {
                        const resolved = await resolveAccountId(
                          context.actor.userId,
                          current.provider,
                          pendingRef,
                          [],
                          context.actor.spaceId,
                        ).catch(() => undefined);
                        revokeRef = resolved ?? "";
                      }
                      if (revokeRef) {
                        await transactionConnector.revoke(revokeRef, revokedContext);
                      }
                    }
                  } else {
                    const revokeUnreferenced = (
                      transactionConnector as {
                        revokeUnreferencedAccounts?: (
                          slug: string,
                          keepAccountIds: string[],
                          context: typeof revokedContext,
                        ) => Promise<void>;
                      }
                    ).revokeUnreferencedAccounts;
                    if (revokeUnreferenced) {
                      const kept = await tx.connection.findMany({
                        where: {
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                          connectorId: existing.connectorId,
                          provider: existing.provider,
                          status: { in: ["connected", "pending", "error"] },
                        },
                        select: { providerRef: true },
                      });
                      const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                        [
                          ...kept.map((entry) => entry.providerRef),
                          ...(await otherSpaceRefs(
                            tx,
                            context.actor,
                            existing.connectorId,
                            existing.provider,
                          )),
                        ],
                        existing.provider,
                      );
                      if (canRevokeUnreferenced) {
                        await revokeUnreferenced(existing.provider, keepIds, revokedContext);
                      }
                    }
                  }
                } catch (error) {
                  getLogger().error(
                    "connections.complete remote cleanup failed for revoked row",
                    error,
                    {
                      connectionId: current.id,
                      connectorId: existing.connectorId,
                      provider: existing.provider,
                    },
                  );
                  await restoreRevokedForRetry();
                  // Still superseded: stop the poll so it cannot complete the restored row,
                  // which stays pending in the account list for removal.
                  throw new IsolationError();
                }
                // A newer attempt or a removal superseded this one. Report it so the
                // caller stops polling instead of retrying an error.
                return current;
              }

              const adapterContext = connectionContext(
                context.actor,
                "connections.complete",
                context.signal,
              );
              if (input.code) {
                const state = current.providerRef ?? current.provider;
                try {
                  await transactionConnector.complete({ state, code: input.code }, adapterContext);
                } catch (error) {
                  throw new ORPCError("BAD_REQUEST", { message: sanitizeConnectorError(error) });
                }
              }
              const ready = await transactionConnector.connectionReady(
                adapterContext,
                current.provider,
              );
              if (!ready) return current;

              // Browser OAuth stores a connection-request id in providerRef from
              // begin. Resolve it to the connected-account id so revoke deletes the
              // right remote authorization. Prefer an account id not already used
              // by a sibling row for the same provider.
              const resolveAccountId = (
                transactionConnector as {
                  resolveConnectedAccountId?: (
                    userId: string,
                    slug: string,
                    currentRef: string | null | undefined,
                    excludeIds?: string[],
                    spaceId?: string,
                  ) => Promise<string | undefined>;
                  connectedAccountId?: (
                    userId: string,
                    slug: string,
                  ) => Promise<string | undefined>;
                }
              ).resolveConnectedAccountId;
              const fallbackAccountId = (
                transactionConnector as {
                  connectedAccountId?: (
                    userId: string,
                    slug: string,
                  ) => Promise<string | undefined>;
                }
              ).connectedAccountId;
              let resolvedAccountId: string | undefined;
              if (resolveAccountId || fallbackAccountId) {
                const siblings = await tx.connection.findMany({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                    id: { not: existing.id },
                    status: { in: ["connected", "pending", "error"] },
                  },
                  select: { providerRef: true },
                });
                // Exclude concrete account ids only. A pending sibling may still
                // store a slug or authorization-request id; passing those raw refs
                // would not match remote account ids and can let this row adopt the
                // sibling's account. If a sibling ref cannot be resolved yet, leave
                // this row pending so a later complete can re-resolve safely.
                const excludeIds: string[] = [];
                let unresolvedSibling = false;
                for (const sibling of siblings) {
                  const ref = sibling.providerRef?.trim();
                  // Slug-only refs cannot identify a concrete remote account; resolving
                  // them would pick an arbitrary ACTIVE id and over-exclude.
                  if (!ref || ref === existing.provider) continue;
                  if (resolveAccountId) {
                    const resolvedSiblingId = await resolveAccountId(
                      context.actor.userId,
                      existing.provider,
                      ref,
                      [],
                      context.actor.spaceId,
                    ).catch(() => undefined);
                    if (resolvedSiblingId) {
                      excludeIds.push(resolvedSiblingId);
                    } else {
                      unresolvedSibling = true;
                    }
                  } else {
                    excludeIds.push(ref);
                  }
                }
                // Another Space's accounts are never this row's, whatever their state.
                for (const ref of await otherSpaceRefs(
                  tx,
                  context.actor,
                  existing.connectorId,
                  existing.provider,
                )) {
                  if (ref?.trim() && ref !== existing.provider) excludeIds.push(ref.trim());
                }
                if (unresolvedSibling) {
                  return current;
                }
                resolvedAccountId = resolveAccountId
                  ? await resolveAccountId(
                      context.actor.userId,
                      existing.provider,
                      current.providerRef,
                      excludeIds,
                      context.actor.spaceId,
                    ).catch(() => undefined)
                  : await fallbackAccountId!(context.actor.userId, existing.provider).catch(
                      () => undefined,
                    );
              }

              // When a resolver exists and providerRef is still a request-scoped
              // id (not the provider slug), require a concrete account id before
              // marking connected — otherwise revoke would delete the wrong ref.
              if (
                resolveAccountId &&
                current.providerRef &&
                current.providerRef !== current.provider &&
                !resolvedAccountId
              ) {
                return current;
              }

              const providerRef = resolvedAccountId ?? current.providerRef;
              if (providerRef) {
                const taken = await tx.connection.findFirst({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                    id: { not: existing.id },
                    status: { in: ["connected", "pending", "error"] },
                    providerRef,
                  },
                  select: { id: true },
                });
                if (taken) {
                  // Do not mark connected with a request-scoped or shared ref —
                  // leave pending so a later complete can re-resolve an unused id.
                  return current;
                }
              }
              // Catalog reconciliation does not take the provider lock, so it may have
              // connected this row meanwhile; only the call that changes it records the event.
              const updated = await tx.connection.updateMany({
                where: { id: current.id, status: current.status },
                data: {
                  status: "connected",
                  ...(providerRef ? { providerRef } : {}),
                },
              });
              connectedNow = updated.count > 0;
              if (!connectedNow && providerRef) {
                // Reconciliation sets only the status; keep the resolved account id so
                // revoke still deletes the right remote account.
                await tx.connection.updateMany({
                  where: { id: current.id, status: "connected" },
                  data: { providerRef },
                });
              }
              const next = await tx.connection.findFirst({
                where: {
                  id: current.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
              if (!next) throw new IsolationError();
              return next;
            },
            { timeout: 60_000 },
          );
        }
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      rename: authed.connections.rename.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const row = await deps.prisma.connection.update({
          where: { id: existing.id },
          data: { displayName: input.displayName },
        });
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      revoke: authed.connections.revoke.handler(async ({ context, input }) => {
        type RemoteRevoke = {
          connectorId: string;
          connectionRef: string;
          accountSpecific: boolean;
        };
        const snapshot = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        const needsProvider =
          snapshot &&
          ["connected", "pending", "error"].includes(snapshot.status) &&
          (!snapshot.providerRef || snapshot.providerRef === snapshot.provider) &&
          (await deps.prisma.connection.count({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: snapshot.connectorId,
              provider: snapshot.provider,
              id: { not: snapshot.id },
              status: { in: ["connected", "pending"] },
            },
          })) === 0;
        const configured = needsProvider
          ? deps.connectors.managed(snapshot.connectorId)
          : undefined;
        const prepared = configured ? { provider: configured } : undefined;
        const outcome = await deps.prisma.$transaction(
          async (tx) => {
            const row = await tx.connection.findFirst({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!row) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Advisory lock covers inserts as well as existing rows. SELECT FOR UPDATE
            // alone misses a concurrent begin that inserts after the lock query.
            await lockProviderConnectionScope(tx, context.actor, row.connectorId, row.provider);
            await tx.$queryRaw`
              SELECT id
              FROM connections
              WHERE "spaceId" = ${context.actor.spaceId}
                AND "userId" = ${context.actor.userId}
                AND "connectorId" = ${row.connectorId}
                AND provider = ${row.provider}
                AND status IN ('connected', 'pending', 'error')
              FOR UPDATE`;

            const updated = await tx.connection.updateMany({
              where: {
                id: row.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: { in: ["connected", "pending", "error"] },
              },
              data: { status: "revoked" },
            });
            if (updated.count === 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // A live row in another Space counts: a provider-wide delete would take its account.
            const remaining =
              (await tx.connection.count({
                where: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  connectorId: row.connectorId,
                  provider: row.provider,
                  status: { in: ["connected", "pending"] },
                },
              })) +
              (
                await otherSpaceRefs(tx, context.actor, row.connectorId, row.provider, [
                  "connected",
                  "pending",
                ])
              ).length;
            const connectionRef = row.providerRef || row.provider;
            const accountSpecific = Boolean(row.providerRef && row.providerRef !== row.provider);
            // Account-scoped refs can disconnect one remote authorization while
            // siblings remain. Slug-only legacy rows must wait until they are last,
            // or a provider-wide revoke would drop every account for that app.
            if (!accountSpecific && remaining > 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Slug-only remote delete is provider-wide. Run it before commit while
            // still holding the begin/revoke lock so a new authorization cannot be
            // created and then wiped by a provider-wide DELETE.
            if (!accountSpecific) {
              if (
                !needsProvider ||
                row.connectorId !== snapshot?.connectorId ||
                row.provider !== snapshot?.provider
              ) {
                throw new ORPCError("CONFLICT", {
                  message: "Integration credentials changed; retry.",
                });
              }
              const connector = prepared?.provider;
              if (!connector) {
                throw new ORPCError("BAD_REQUEST", {
                  message: `Connector ${row.connectorId} is not configured`,
                });
              }
              try {
                // Abort before the 60s Prisma transaction timeout so a late remote
                // delete cannot succeed after local status has already rolled back.
                const signals = [AbortSignal.timeout(45_000)];
                if (context.signal) signals.unshift(context.signal);
                const revokeSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
                await connector.revoke(
                  connectionRef,
                  connectionContext(context.actor, "connections.revoke", revokeSignal),
                );
              } catch (error) {
                if (error instanceof ORPCError) throw error;
                throw new ORPCError("BAD_REQUEST", { message: sanitizeConnectorError(error) });
              }
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            return {
              remote: {
                connectorId: row.connectorId,
                connectionRef,
                accountSpecific,
              },
              previousStatus: row.status,
            };
          },
          { timeout: 60_000 },
        );

        if (outcome.remote) {
          const restoreLocalStatus = async () => {
            // Local row was marked revoked inside the transaction; restore it so a
            // failed remote disconnect remains retryable instead of orphaned.
            if (!outcome.previousStatus) return;
            await deps.prisma.connection.updateMany({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: "revoked",
              },
              data: { status: outcome.previousStatus },
            });
          };
          try {
            const connector = deps.connectors.managed(outcome.remote.connectorId);
            if (!connector) {
              throw new ORPCError("BAD_REQUEST", {
                message: `Connector ${outcome.remote.connectorId} is not configured`,
              });
            }
            await connector.revoke(
              outcome.remote.connectionRef,
              connectionContext(context.actor, "connections.revoke", context.signal),
            );
          } catch (error) {
            // Restore when DELETE clearly did not run (including pre-delete list
            // timeouts). Post-delete timeouts stay ambiguous — leave revoked.
            if (shouldRestoreLocalAfterRemoteRevokeFailure(error)) {
              await restoreLocalStatus();
            } else {
              getLogger().error(
                "connections.revoke remote outcome uncertain; leaving local revoked",
                error,
                {
                  connectionId: input.connectionId,
                  connectorId: outcome.remote.connectorId,
                },
              );
            }
            if (error instanceof ORPCError) throw error;
            throw new ORPCError("BAD_REQUEST", { message: sanitizeConnectorError(error) });
          }
        }
        return { ok: true as const };
      }),
      tools: authed.connections.tools.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) return [];
        const row = await deps.prisma.connection.findFirst({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
            status: "connected",
          },
        });
        if (!row) return [];
        try {
          const tools = await connector.discoverTools({
            ...connectionContext(context.actor, "connections.tools", context.signal),
            connectedConnections: [
              {
                id: row.id,
                connectorId: input.connectorId,
                externalId: input.provider,
                displayName: row.displayName,
                providerRef: row.providerRef ?? undefined,
              },
            ],
            connectedProviders: [input.provider],
          });
          return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          }));
        } catch (error) {
          getLogger().error("connections.tools failed", error, {
            connectorId: input.connectorId,
            provider: input.provider,
          });
          return [];
        }
      }),
    },
  };
}
