import { ORPCError } from "@orpc/server";
import type { McpOAuthSummary } from "@rakazo/adapters";
import {
  assertSafeRemoteUrl,
  buildMcpCredentialBlob,
  mcpServerHealthDto,
  persistPreparedSecret,
  recordMcpServerHealth,
} from "@rakazo/adapters";
import type { Actor, McpServer } from "@rakazo/contracts";
import { mcpOAuthEnvReferences } from "@rakazo/contracts";
import { IsolationError, type Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  dismissMcpServerApprovals,
  resolveMcpApprovalCards,
  revertConnectedMcpApprovals,
} from "../mcp-approval.js";
import { buildMcpUpdateMaterial } from "../mcp-material.js";
import type { RouterContext, RouterDeps } from "./shared.js";
import {
  authed,
  computerContext,
  MCP_OAUTH_PENDING_MESSAGE,
  mayUsePrivateEndpoint,
} from "./shared.js";

function mcpServerDto(
  row: {
    id: string;
    spaceId: string;
    slug: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
    env: unknown;
    files: unknown;
    headers: unknown;
    secretId: string | null;
    enabled: boolean;
    revision: number;
    healthStatus: string;
    healthMessage: string | null;
    healthToolCount: number | null;
    healthCheckedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  oauth: McpOAuthSummary = { status: "none", clientId: null },
): McpServer {
  const args = Array.isArray(row.args)
    ? row.args.filter((item): item is string => typeof item === "string")
    : [];
  const keysOf = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const envKeys = keysOf(row.env);
  const headerKeys = keysOf(row.headers);
  return {
    id: row.id,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServer["transport"],
    endpoint: row.endpoint,
    command: row.command,
    args,
    envKeys,
    fileKeys: keysOf(row.files),
    headerKeys,
    hasSecret: row.secretId !== null,
    oauthStatus: oauth.status,
    oauthClientId: oauth.clientId,
    enabled: row.enabled,
    revision: row.revision,
    health: mcpServerHealthDto(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertMcpRemoteEndpoint(
  endpoint: string | null | undefined,
  actor: Actor,
  deps: Pick<RouterDeps, "remoteConnectors" | "env">,
): Promise<void> {
  if (!endpoint) return;
  try {
    await assertSafeRemoteUrl(endpoint, deps.remoteConnectors?.resolveHostname, {
      allowPrivateEndpoint: mayUsePrivateEndpoint(actor, deps),
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "MCP endpoint is invalid",
    });
  }
}

/** A stdio server gets its OAuth grant through `{{oauth.*}}` references in env
 * values and credential file templates, so they must name real fields and the
 * server must have a client to run the flow. A key is either a value or a file path. */
function assertMcpOAuthTemplates(
  env: Record<string, string>,
  files: Record<string, string>,
  hasOAuthClient: boolean,
): void {
  for (const key of Object.keys(files)) {
    if (key in env) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${key} is set as both an environment variable and a credential file`,
      });
    }
  }
  const sources = [
    ...Object.entries(env).map(([key, value]) => ({ label: `Environment variable ${key}`, value })),
    ...Object.entries(files).map(([key, value]) => ({ label: `Credential file ${key}`, value })),
  ];
  for (const { label, value } of sources) {
    const { fields, unknown } = mcpOAuthEnvReferences(value);
    if (unknown[0] !== undefined) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${label} references unknown OAuth field {{oauth.${unknown[0]}}}`,
      });
    }
    if (fields[0] !== undefined && !hasOAuthClient) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${label} uses {{oauth.${fields[0]}}}, which needs an OAuth client`,
      });
    }
  }
}

function mcpAssignmentDto(row: {
  id: string;
  botId: string;
  serverId: string;
  allowAllTools: boolean;
  allowedTools: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    serverId: row.serverId,
    allowAllTools: row.allowAllTools,
    allowedTools: Array.isArray(row.allowedTools)
      ? row.allowedTools.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mcpRouter(ctx: RouterContext) {
  const { deps, onboardingDeps, mcpOAuth, mcpAwaitsOAuth, probeMcpServer, beginMcpProbe } = ctx;
  return {
    mcp: {
      servers: {
        list: authed.mcp.servers.list.handler(async ({ context }) => {
          const rows = await deps.prisma.mcpServer.findMany({
            where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true, ciphertext: true },
              })
            : [];
          const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
          return Promise.all(
            rows.map(async (row) =>
              mcpServerDto(
                row,
                await mcpOAuth.summaryForCiphertext(
                  row.secretId ? ciphertextById.get(row.secretId) : undefined,
                  row.secretId ?? undefined,
                ),
              ),
            ),
          );
        }),
        create: authed.mcp.servers.create.handler(async ({ context, input }) => {
          await assertMcpRemoteEndpoint(
            "endpoint" in input ? input.endpoint : null,
            context.actor,
            deps,
          );
          if (input.transport === "stdio") {
            assertMcpOAuthTemplates(input.env, input.files ?? {}, Boolean(input.oauthClient));
            await assertMcpRemoteEndpoint(
              input.oauthClient?.authorizationServer,
              context.actor,
              deps,
            );
          }
          const secretPayload = buildMcpCredentialBlob(input);
          const stored = secretPayload
            ? await deps.secrets.put(
                secretPayload,
                computerContext(context.actor, "mcp", "mcp.create"),
              )
            : null;
          const row = await deps.prisma.$transaction(async (tx) => {
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            return tx.mcpServer.create({
              data: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                slug: input.slug,
                name: input.name,
                description: input.description,
                transport: input.transport,
                endpoint: "endpoint" in input ? input.endpoint : null,
                command: "command" in input ? input.command : null,
                args: ("args" in input ? input.args : []) as Prisma.InputJsonValue,
                env: ("env" in input
                  ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                files: Object.fromEntries(
                  Object.keys("files" in input ? (input.files ?? {}) : {}).map((key) => [
                    key,
                    true,
                  ]),
                ) as Prisma.InputJsonValue,
                headers: ("headers" in input
                  ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                secretId: stored?.id,
                enabled: input.enabled,
              },
            });
          });
          const oauth = await mcpOAuth.summaryFor(row, context.actor);
          return mcpServerDto(await beginMcpProbe(row, context.actor, oauth), oauth);
        }),
        update: authed.mcp.servers.update.handler(async ({ context, input }) => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const { existing, existingSecret } = await deps.prisma.$transaction(async (tx) => {
              const existing = await tx.mcpServer.findFirst({
                where: {
                  id: input.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
              if (!existing) throw new IsolationError();
              const existingSecret = existing.secretId
                ? await tx.secret.findFirst({
                    where: {
                      id: existing.secretId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                  })
                : null;
              return { existing, existingSecret };
            });
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(
                  await deps.secrets.load(existingSecret.ciphertext, existingSecret.id),
                );
                if (value && typeof value === "object" && !Array.isArray(value))
                  existingMaterial = value as Record<string, unknown>;
              } catch {
                /* Existing malformed secrets are replaced only when new credentials are supplied. */
              }
            }
            const config =
              "config" in input
                ? input.config
                : {
                    slug: existing.slug,
                    name: existing.name,
                    description: existing.description,
                    enabled: existing.enabled,
                    transport: existing.transport as "streamable_http" | "sse",
                    endpoint: existing.endpoint!,
                    headers: (existingMaterial.headers ?? {}) as Record<string, string>,
                    secret: input.secret,
                  };
            if (!("config" in input) && existing.transport === "stdio") {
              throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
            }
            const nextEndpoint = "endpoint" in config ? config.endpoint : null;
            if (existing.endpoint !== nextEndpoint) {
              await assertMcpRemoteEndpoint(nextEndpoint, context.actor, deps);
            }
            if (config.transport === "stdio") {
              await assertMcpRemoteEndpoint(
                config.oauthClient?.authorizationServer,
                context.actor,
                deps,
              );
            }
            const update = buildMcpUpdateMaterial(existingMaterial, config, {
              clearOAuth: existing.endpoint !== nextEndpoint,
            });
            if (update.action === "store" && config.transport === "stdio") {
              await assertMcpRemoteEndpoint(
                update.material.oauthClient?.authorization_server,
                context.actor,
                deps,
              );
              assertMcpOAuthTemplates(
                update.material.env ?? {},
                update.material.files ?? {},
                Boolean(update.material.oauthClient),
              );
            }
            const stored =
              update.action === "store" && Object.keys(update.material).length > 0
                ? await deps.secrets.put(
                    JSON.stringify(update.material),
                    computerContext(context.actor, "mcp", "mcp.update"),
                  )
                : null;
            const clearing = update.action === "store" && Object.keys(update.material).length === 0;
            const row = await persistPreparedSecret(
              deps.prisma,
              deps.secrets,
              stored ?? undefined,
              () =>
                deps.prisma.$transaction(async (tx) => {
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.id}))`;
                  const current = await tx.mcpServer.findFirst({
                    where: {
                      id: input.id,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                  });
                  if (!current) throw new IsolationError();
                  if (
                    current.revision !== existing.revision ||
                    current.secretId !== existing.secretId ||
                    current.endpoint !== existing.endpoint
                  )
                    return null;
                  if (current.secretId)
                    await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${current.secretId} FOR UPDATE`;
                  const secret = current.secretId
                    ? await tx.secret.findFirst({
                        where: {
                          id: current.secretId,
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                        },
                      })
                    : null;
                  if (secret?.ciphertext !== existingSecret?.ciphertext) return null;
                  if (stored) {
                    await tx.secret.create({
                      data: {
                        id: stored.id,
                        userId: context.actor.userId,
                        spaceId: context.actor.spaceId,
                        kind: "mcp",
                        ciphertext: stored.ciphertext,
                      },
                    });
                  }
                  const updated = await tx.mcpServer.update({
                    where: { id: existing.id },
                    data: {
                      slug: config.slug,
                      name: config.name,
                      description: config.description,
                      transport: config.transport,
                      endpoint: nextEndpoint,
                      command: "command" in config ? config.command : null,
                      args: ("args" in config ? config.args : []) as Prisma.InputJsonValue,
                      env: ("env" in config
                        ? Object.fromEntries(Object.keys(config.env).map((key) => [key, true]))
                        : {}) as Prisma.InputJsonValue,
                      // Omitted files are kept in the material, so the keys follow it.
                      ...(update.action === "store"
                        ? {
                            files: Object.fromEntries(
                              Object.keys(update.material.files ?? {}).map((key) => [key, true]),
                            ) as Prisma.InputJsonValue,
                          }
                        : {}),
                      headers: ("headers" in config
                        ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, true]))
                        : {}) as Prisma.InputJsonValue,
                      enabled: config.enabled,
                      revision: { increment: 1 },
                      // The old verdict is about the old config.
                      healthStatus: "unknown",
                      healthMessage: null,
                      healthToolCount: null,
                      healthCheckedAt: null,
                      ...(stored ? { secretId: stored.id } : clearing ? { secretId: null } : {}),
                    },
                  });
                  if ((stored || clearing) && existing.secretId)
                    await tx.secret.deleteMany({
                      where: {
                        id: existing.secretId,
                        spaceId: context.actor.spaceId,
                        userId: context.actor.userId,
                      },
                    });
                  return updated;
                }),
            );
            if (row) {
              const oauth = await mcpOAuth.summaryFor(row, context.actor);
              return mcpServerDto(await beginMcpProbe(row, context.actor, oauth), oauth);
            }
          }
          throw new ORPCError("CONFLICT", { message: "MCP credentials changed; retry" });
        }),
        test: authed.mcp.servers.test.handler(async ({ context, input }) => {
          const scope = {
            id: input.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          };
          const server = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!server) throw new IsolationError();
          const oauth = await mcpOAuth.summaryFor(server, context.actor);
          if (!deps.mcp) {
            await recordMcpServerHealth(deps.prisma, server.id, {
              status: "error",
              message: "This server cannot be checked from here.",
            });
          } else if (await mcpAwaitsOAuth(server, context.actor, oauth)) {
            await recordMcpServerHealth(deps.prisma, server.id, {
              status: "unknown",
              message: MCP_OAUTH_PENDING_MESSAGE,
            });
          } else {
            await probeMcpServer(server, context.actor);
          }
          const fresh = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!fresh) throw new IsolationError();
          return mcpServerDto(fresh, oauth);
        }),
        remove: authed.mcp.servers.remove.handler(async ({ context, input }) => {
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true, secretId: true },
          });
          if (!server) throw new IsolationError();
          // Assignments cascade; the encrypted credential must go with the server.
          // Cards are closed first, including ones that were never assigned.
          const seqs = await deps.prisma.$transaction(async (tx) => {
            const painted = await dismissMcpServerApprovals(
              onboardingDeps,
              context.actor,
              server.id,
              tx,
            );
            await tx.mcpServer.delete({ where: { id: server.id } });
            if (server.secretId) {
              await tx.secret.deleteMany({
                where: {
                  id: server.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
            return painted;
          });
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return { ok: true as const };
        }),
      },
      assignments: {
        all: authed.mcp.assignments.all.handler(async ({ context }) => {
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        list: authed.mcp.assignments.list.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        approve: authed.mcp.assignments.approve.handler(async ({ context, input }) => {
          const row = await resolveMcpApprovalCards(
            onboardingDeps,
            context.actor,
            {
              botId: input.botId,
              serverId: input.serverId,
              status: "connected",
              threadId: input.threadId,
            },
            async (tx, decision) => {
              if (!decision.assign) throw new IsolationError();
              const [bot, server] = await Promise.all([
                tx.bot.findFirst({
                  where: {
                    id: input.botId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                  select: { id: true },
                }),
                tx.mcpServer.findFirst({
                  where: {
                    id: input.serverId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    enabled: true,
                  },
                  select: { id: true },
                }),
              ]);
              if (!bot || !server) throw new IsolationError();
              return tx.botMcpServer.upsert({
                where: { botId_serverId: { botId: bot.id, serverId: server.id } },
                create: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: server.id,
                  allowAllTools: true,
                  allowedTools: [],
                },
                update: {},
              });
            },
          );
          if (!row) throw new IsolationError();
          return mcpAssignmentDto(row);
        }),
        dismiss: authed.mcp.assignments.dismiss.handler(async ({ context, input }) => {
          // Not now resolves the card only. Assignments are never touched
          // here: a stale card must not delete a live connection, and server
          // removal belongs to the MCP settings surface.
          await resolveMcpApprovalCards(onboardingDeps, context.actor, {
            botId: input.botId,
            serverId: input.serverId,
            status: "dismissed",
            threadId: input.threadId,
          });
          return { ok: true as const };
        }),
        replace: authed.mcp.assignments.replace.handler(async ({ context, input }) => {
          const { rows, seqs } = await deps.prisma.$transaction(async (tx) => {
            const bot = await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            const previous = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { serverId: true },
            });
            const nextIds = new Set(input.assignments.map((assignment) => assignment.serverId));
            const removed = previous
              .map((row) => row.serverId)
              .filter((serverId) => !nextIds.has(serverId));
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: assignment.serverId,
                  allowAllTools: assignment.allowAllTools,
                  allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
                })),
              });
            const seqs = (
              await Promise.all(
                removed.map((serverId) =>
                  revertConnectedMcpApprovals(
                    onboardingDeps,
                    context.actor,
                    { botId: bot.id, serverId, status: "pending" },
                    tx,
                  ),
                ),
              )
            ).flat();
            const rows = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: { createdAt: "asc" },
            });
            return { rows, seqs };
          });
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return rows.map(mcpAssignmentDto);
        }),
      },
      oauth: {
        begin: authed.mcp.oauth.begin.handler(async ({ context, input }) => {
          try {
            const expectedRedirect = new URL("/mcp/oauth/callback", deps.env.webOrigin).toString();
            if (new URL(input.redirectUri).toString() !== expectedRedirect) {
              throw new Error("MCP OAuth redirect URI is not allowed");
            }
            return await mcpOAuth.begin({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start MCP OAuth",
            });
          }
        }),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          try {
            // complete() consumes the session, so which server it belongs to is read first.
            const session = deps.mcp
              ? await deps.prisma.mcpOAuthSession
                  .findFirst({
                    where: {
                      id: input.sessionId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                    select: { serverId: true },
                  })
                  .catch(() => null)
              : null;
            await mcpOAuth.complete({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
            if (session) {
              // The account is connected now: check the server so it shows ok/error.
              void (async () => {
                const server = await deps.prisma.mcpServer.findFirst({
                  where: {
                    id: session.serverId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                });
                if (server)
                  await beginMcpProbe(
                    server,
                    context.actor,
                    await mcpOAuth.summaryFor(server, context.actor),
                  );
              })().catch((error) =>
                getLogger().error("mcp server probe after oauth failed", error),
              );
            }
            return { ok: true as const };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not complete MCP OAuth",
            });
          }
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          return { ok: true as const };
        }),
      },
    },
  };
}
