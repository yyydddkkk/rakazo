import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Actor, WorkflowPackage, WorkflowPackageContent } from "@rakazo/contracts";
import { WorkflowPackageContentSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { cancelRunsInTransaction, IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export type WorkflowPackageRemoval = (scope: {
  spaceId: string;
  packageId: string;
  revisionId: string;
}) => Promise<void>;

type Source = { url: string; revision: string; packagePath?: string };
export type WorkflowPackageInstaller = (
  source: Source,
  scope: { spaceId: string; packageId: string; revisionId: string },
) => Promise<WorkflowPackageContent>;
type Row = Prisma.WorkflowPackageGetPayload<{ include: { activeRevision: true } }>;
type Tx = Prisma.TransactionClient;

function dto(row: Row): WorkflowPackage {
  const revision = row.activeRevision;
  if (!revision) throw new IsolationError();
  const content = WorkflowPackageContentSchema.parse(revision.content);
  return {
    id: row.id,
    alias: row.alias,
    enabled: row.enabled,
    name: content.name,
    version: content.version,
    revisionId: revision.id,
    commit: revision.commit,
    digest: revision.digest,
    url: revision.url,
    requestedRevision: revision.requestedRevision,
    packagePath: revision.packagePath,
    license: content.license,
    omitted: content.omitted,
    skills: content.skills.map(({ content: _content, ...skill }) => skill),
    agents: content.agents.map(({ content: _content, ...agent }) => agent),
    createdAt: row.createdAt.toISOString(),
  };
}

export function createWorkflowsService(
  prisma: PrismaClient,
  install: WorkflowPackageInstaller,
  onRunsCancelled?: (actor: Actor, runIds: string[]) => Promise<void>,
  removeFiles?: WorkflowPackageRemoval,
) {
  const scope = (actor: Actor) => ({ spaceId: actor.spaceId, userId: actor.userId });
  async function owned(
    tx: Tx | PrismaClient,
    actor: Actor,
    packageId: string,
    includeDeleted = false,
  ) {
    const row = await tx.workflowPackage.findFirst({
      where: { id: packageId, ...scope(actor), ...(includeDeleted ? {} : { deletedAt: null }) },
      include: { activeRevision: true },
    });
    if (!row) throw new IsolationError();
    return row;
  }
  async function lock(tx: Tx, actor: Actor, packageId: string, includeDeleted = false) {
    await tx.$queryRaw`SELECT id FROM workflow_packages WHERE id = ${packageId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`;
    return owned(tx, actor, packageId, includeDeleted);
  }
  async function bot(tx: Tx | PrismaClient, actor: Actor, botId: string, locking = false) {
    if (locking)
      await (tx as Tx)
        .$queryRaw`SELECT id FROM bots WHERE id = ${botId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`;
    const row = await tx.bot.findFirst({ where: { id: botId, ...scope(actor), archivedAt: null } });
    if (!row) throw new IsolationError();
    return row;
  }
  async function cancel(tx: Tx, actor: Actor, packageId: string, botId?: string) {
    const runs = await tx.run.findMany({
      where: {
        ...scope(actor),
        ...(botId ? { botId } : {}),
        status: { notIn: ["completed", "failed", "cancelled"] },
        workflowSnapshot: { path: [], array_contains: [{ packageId }] },
      },
      select: { id: true, taskId: true },
    });
    await cancelRunsInTransaction(tx, runs, new Date());
    return runs.map((run) => run.id);
  }
  async function cleanup(actor: Actor, packageId: string, revisionId: string) {
    await removeFiles?.({ spaceId: actor.spaceId, packageId, revisionId });
  }
  async function cleanupFailed(actor: Actor, packageId: string, revisionId: string) {
    await cleanup(actor, packageId, revisionId).catch(() =>
      getLogger().warn("Workflow revision cleanup failed."),
    );
  }
  async function notify(actor: Actor, ids: string[]) {
    if (ids.length) await onRunsCancelled?.(actor, ids);
  }
  function validateNames(alias: string, content: WorkflowPackageContent) {
    if (content.skills.some((skill) => `${alias}:${skill.name}`.length > 80))
      throw new ORPCError("BAD_REQUEST", {
        message: "Workflow skill names must fit within 80 characters including the alias.",
      });
  }
  function validatePackageNames(
    packages: Array<{ alias: string; content: WorkflowPackageContent }>,
  ) {
    const skills = new Set<string>();
    const agents = new Set(["scout", "reviewer", "security-reviewer", "task", "sonic"]);
    for (const { alias, content } of packages) {
      for (const [entries, names] of [
        [content.skills, skills],
        [content.agents, agents],
      ] as const) {
        for (const entry of entries) {
          const name = entry.name.toLowerCase();
          if (names.has(name))
            throw new ORPCError("CONFLICT", {
              message: `Workflow name conflict: ${alias}:${entry.name}`,
            });
          names.add(name);
        }
      }
    }
  }
  function revisionData(
    packageId: string,
    id: string,
    source: Source,
    content: WorkflowPackageContent,
  ) {
    return {
      id,
      packageId,
      url: source.url,
      requestedRevision: source.revision,
      packagePath: source.packagePath ?? "",
      commit: content.commit,
      digest: content.digest,
      transformVersion: content.transformVersion,
      content: content as Prisma.InputJsonValue,
    };
  }
  return {
    async list(actor: Actor) {
      return (
        await prisma.workflowPackage.findMany({
          where: { ...scope(actor), deletedAt: null, activeRevisionId: { not: null } },
          include: { activeRevision: true },
          orderBy: { alias: "asc" },
        })
      ).map(dto);
    },
    async install(actor: Actor, input: Source & { alias?: string }) {
      const packageId = randomUUID();
      const revisionId = randomUUID();
      try {
        const content = WorkflowPackageContentSchema.parse(
          await install(input, { spaceId: actor.spaceId, packageId, revisionId }),
        );
        const alias =
          input.alias ??
          content.name
            .toLowerCase()
            .replace(/^@/u, "")
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-|-$/gu, "")
            .slice(0, 80);
        validateNames(alias, content);
        if (!alias) throw new ORPCError("BAD_REQUEST", { message: "Provide a workflow alias." });
        return await prisma.$transaction(async (tx) => {
          await tx.workflowPackage.create({ data: { id: packageId, ...scope(actor), alias } });
          await tx.workflowPackageRevision.create({
            data: revisionData(packageId, revisionId, input, content),
          });
          return dto(
            await tx.workflowPackage.update({
              where: { id: packageId },
              data: { activeRevisionId: revisionId },
              include: { activeRevision: true },
            }),
          );
        });
      } catch (error) {
        await cleanupFailed(actor, packageId, revisionId);
        if (error instanceof Error && "code" in error && error.code === "P2002")
          throw new ORPCError("CONFLICT", {
            message: "A workflow with that alias already exists.",
          });
        throw error;
      }
    },
    async updateVersion(actor: Actor, input: { packageId: string; revision: string }) {
      const previous = await owned(prisma, actor, input.packageId);
      if (!previous.activeRevision) throw new IsolationError();
      const source = {
        url: previous.activeRevision.url,
        packagePath: previous.activeRevision.packagePath,
        revision: input.revision,
      };
      const revisionId = randomUUID();
      try {
        const content = WorkflowPackageContentSchema.parse(
          await install(source, { spaceId: actor.spaceId, packageId: input.packageId, revisionId }),
        );
        const result = await prisma.$transaction(async (tx) => {
          const row = await lock(tx, actor, input.packageId);
          validateNames(row.alias, content);
          const selections = await tx.botWorkflowPackage.findMany({ where: { packageId: row.id } });
          const keys = new Set(content.skills.map((skill) => `${row.alias}:${skill.name}`));
          if (selections.some((selection) => selection.alwaysUse.some((key) => !keys.has(key))))
            throw new ORPCError("CONFLICT", {
              message: "Remove unavailable always-use skills before updating.",
            });
          const replacement = { alias: row.alias, content };
          validatePackageNames([replacement]);
          for (const selection of selections) {
            const others = await tx.botWorkflowPackage.findMany({
              where: {
                botId: selection.botId,
                bot: scope(actor),
                package: { ...scope(actor), id: { not: row.id }, enabled: true, deletedAt: null },
              },
              include: { package: { include: { activeRevision: true } } },
            });
            validatePackageNames([
              replacement,
              ...others.map((other) => ({
                alias: other.package.alias,
                content: WorkflowPackageContentSchema.parse(other.package.activeRevision?.content),
              })),
            ]);
          }
          let revision = await tx.workflowPackageRevision.findUnique({
            where: { packageId_commit: { packageId: row.id, commit: content.commit } },
          });
          if (revision && revision.digest !== content.digest)
            throw new ORPCError("CONFLICT", {
              message: "Workflow content changed for the pinned commit.",
            });
          revision ??= await tx.workflowPackageRevision.create({
            data: revisionData(row.id, revisionId, source, content),
          });
          return dto(
            await tx.workflowPackage.update({
              where: { id: row.id },
              data: { activeRevisionId: revision.id },
              include: { activeRevision: true },
            }),
          );
        });
        if (result.revisionId !== revisionId) await cleanup(actor, input.packageId, revisionId);
        return result;
      } catch (error) {
        await cleanupFailed(actor, input.packageId, revisionId);
        throw error;
      }
    },
    async setEnabled(actor: Actor, input: { packageId: string; enabled: boolean }) {
      const result = await prisma.$transaction(async (tx) => {
        const row = await lock(tx, actor, input.packageId);
        const ids = input.enabled ? [] : await cancel(tx, actor, row.id);
        const updated = await tx.workflowPackage.update({
          where: { id: row.id },
          data: { enabled: input.enabled },
          include: { activeRevision: true },
        });
        return { value: dto(updated), ids };
      });
      await notify(actor, result.ids);
      return result.value;
    },
    async remove(actor: Actor, packageId: string) {
      const result = await prisma.$transaction(async (tx) => {
        const row = await lock(tx, actor, packageId, true);
        const ids = await cancel(tx, actor, row.id);
        await tx.botWorkflowPackage.deleteMany({ where: { packageId: row.id } });
        await tx.workflowPackage.update({
          where: { id: row.id },
          data: { enabled: false, deletedAt: new Date() },
        });
        const revisions = await tx.workflowPackageRevision.findMany({
          where: { packageId: row.id },
          select: { id: true },
        });
        const unused = [];
        for (const revision of revisions) {
          const references = await tx.run.count({
            where: {
              ...scope(actor),
              workflowSnapshot: {
                path: [],
                array_contains: [{ packageId: row.id, revisionId: revision.id }],
              },
            },
          });
          if (!references) unused.push(revision.id);
        }
        return { ids, unused };
      });
      await notify(actor, result.ids);
      for (const revisionId of result.unused) await cleanup(actor, packageId, revisionId);
      return { ok: true as const };
    },
    async skillsForBot(actor: Actor, botId: string) {
      await bot(prisma, actor, botId);
      const rows = await prisma.botWorkflowPackage.findMany({
        where: { botId, package: { ...scope(actor), deletedAt: null, enabled: true } },
        include: { package: { include: { activeRevision: true } } },
      });
      return rows.flatMap((row) => {
        const revision = row.package.activeRevision;
        if (!revision) return [];
        const content = WorkflowPackageContentSchema.parse(revision.content);
        return content.skills.map((skill) => ({
          id: `workflow:${row.packageId}:${revision.id}:${skill.name}`,
          name: `${row.package.alias}:${skill.name}`,
          description: skill.description,
          content: skill.content,
          source: "plugin" as const,
          readOnly: true,
          createdAt: revision.createdAt.toISOString(),
          updatedAt: revision.createdAt.toISOString(),
        }));
      });
    },
    async getBot(actor: Actor, botId: string) {
      await bot(prisma, actor, botId);
      const rows = await prisma.botWorkflowPackage.findMany({
        where: { botId, package: { ...scope(actor), deletedAt: null } },
        orderBy: { packageId: "asc" },
      });
      return {
        packageIds: rows.map((row) => row.packageId),
        alwaysUse: rows.flatMap((row) => row.alwaysUse),
      };
    },
    async setBot(
      actor: Actor,
      input: { botId: string; packageIds: string[]; alwaysUse: string[] },
    ) {
      const ids = await prisma.$transaction(async (tx) => {
        await bot(tx, actor, input.botId, true);
        const prior = await tx.botWorkflowPackage.findMany({ where: { botId: input.botId } });
        const rows = [];
        for (const id of [...new Set(input.packageIds)].sort()) {
          const row = await lock(tx, actor, id);
          if (!row.enabled && !prior.some((selection) => selection.packageId === row.id))
            throw new ORPCError("BAD_REQUEST", {
              message: "Enable the workflow in Space settings first.",
            });
          rows.push(row);
        }
        validatePackageNames(
          rows
            .filter((row) => row.enabled)
            .map((row) => ({
              alias: row.alias,
              content: WorkflowPackageContentSchema.parse(row.activeRevision?.content),
            })),
        );
        const keys = new Set(
          rows.flatMap((row) =>
            WorkflowPackageContentSchema.parse(row.activeRevision?.content).skills.map(
              (skill) => `${row.alias}:${skill.name}`,
            ),
          ),
        );
        if (input.alwaysUse.some((key) => !keys.has(key)))
          throw new ORPCError("BAD_REQUEST", {
            message: "Choose always-use skills from selected workflows.",
          });
        const cancelled = [];
        for (const removed of prior.filter((row) => !input.packageIds.includes(row.packageId)))
          cancelled.push(...(await cancel(tx, actor, removed.packageId, input.botId)));
        await tx.botWorkflowPackage.deleteMany({ where: { botId: input.botId } });
        for (const row of rows)
          await tx.botWorkflowPackage.create({
            data: {
              botId: input.botId,
              packageId: row.id,
              alwaysUse: [
                ...new Set(input.alwaysUse.filter((key) => key.startsWith(`${row.alias}:`))),
              ],
            },
          });
        return cancelled;
      });
      await notify(actor, ids);
      return {
        packageIds: [...new Set(input.packageIds)],
        alwaysUse: [...new Set(input.alwaysUse)],
      };
    },
  };
}
