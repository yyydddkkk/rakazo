import path from "node:path";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { WorkflowPackageContent } from "@rakazo/contracts";
import type { SkillRecord } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { WorkflowPackageStore } from "./workflow-package-store.js";

const snapshotSchema = z.array(
  z.object({
    packageId: z.string(),
    revisionId: z.string(),
    alwaysUse: z.array(z.string()),
  }),
);
export type WorkflowRunScope = { id: string; spaceId: string; userId: string; botId: string };
export type ResolvedWorkflow = {
  packageId: string;
  revisionId: string;
  alias: string;
  alwaysUse: string[];
  content: WorkflowPackageContent;
};

export function createWorkflowResolver(options: { prisma: PrismaClient; dataDir: string }) {
  const store = new WorkflowPackageStore({ dataDir: options.dataDir });
  return async (scope: WorkflowRunScope): Promise<ResolvedWorkflow[]> => {
    const revisions = await options.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE`;
      const run = await tx.run.findFirst({
        where: { id: scope.id, spaceId: scope.spaceId, userId: scope.userId, botId: scope.botId },
      });
      if (!run || run.status === "cancelled") throw new Error("Workflow run is unavailable.");
      const selections = await tx.botWorkflowPackage.findMany({
        where: { botId: scope.botId },
        orderBy: { packageId: "asc" },
        include: { package: true },
      });
      const snapshot =
        run.workflowSnapshot == null
          ? selections
              .filter((s) => s.package.enabled && !s.package.deletedAt)
              .map((s) => ({
                packageId: s.packageId,
                revisionId: s.package.activeRevisionId!,
                alwaysUse: s.alwaysUse,
              }))
          : snapshotSchema.parse(run.workflowSnapshot);
      const resolved = [];
      for (const entry of snapshot) {
        await tx.$queryRaw`SELECT id FROM workflow_packages WHERE id = ${entry.packageId} AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE`;
        const selected = selections.find((s) => s.packageId === entry.packageId);
        const pkg = await tx.workflowPackage.findFirst({
          where: { id: entry.packageId, spaceId: scope.spaceId, userId: scope.userId },
        });
        if (!selected || !pkg?.enabled || pkg.deletedAt) {
          throw new Error("A workflow package was disabled or uninstalled.");
        }
        if (run.workflowSnapshot == null) {
          if (!pkg.activeRevisionId) throw new Error("Workflow revision is unavailable.");
          entry.revisionId = pkg.activeRevisionId;
        }
        const revision = await tx.workflowPackageRevision.findFirst({
          where: { id: entry.revisionId, packageId: entry.packageId },
        });
        if (!revision) throw new Error("Workflow revision is unavailable.");
        resolved.push({ ...entry, alias: pkg.alias, digest: revision.digest });
      }
      if (run.workflowSnapshot == null) {
        await tx.run.update({ where: { id: scope.id }, data: { workflowSnapshot: snapshot } });
      }
      return resolved;
    });
    return Promise.all(
      revisions.map(async ({ digest, ...revision }) => {
        const content = await store.read({
          spaceId: scope.spaceId,
          packageId: revision.packageId,
          revisionId: revision.revisionId,
        });
        if (content.digest !== digest) throw new Error("Workflow revision integrity check failed.");
        return { ...revision, content };
      }),
    );
  };
}

export function workflowSkillRecords(
  workflows: ResolvedWorkflow[],
  existing: SkillRecord[],
): SkillRecord[] {
  const records = workflows.flatMap((workflow) =>
    workflow.content.skills.map((skill) => ({
      id: `workflow:${workflow.packageId}:${workflow.revisionId}:${skill.name}`,
      name: `${workflow.alias}:${skill.name}`,
      description: skill.description,
      source: "plugin" as const,
      readOnly: true,
      content: `${skill.content}\n\nWorkflow: ${workflow.alias}:${skill.name}. Read related skills/resources with skill_read using this qualified name and path; relative paths resolve inside this package.`,
    })),
  );
  const existingNames = new Set(existing.map((s) => s.name.toLowerCase()));
  const names = new Set<string>();
  for (const workflow of workflows) {
    for (const skill of workflow.content.skills) {
      const qualified = `${workflow.alias}:${skill.name}`;
      if (existingNames.has(qualified.toLowerCase()))
        throw new Error(`Workflow skill name conflicts: ${qualified}`);
      for (const name of [skill.name, qualified]) {
        const key = name.toLowerCase();
        if (names.has(key)) throw new Error(`Workflow skill name conflicts: ${name}`);
        names.add(key);
      }
    }
  }
  const short = records
    .filter((record) => !existingNames.has(record.name.split(":").at(-1)!.toLowerCase()))
    .map((record) => ({ ...record, name: record.name.split(":").at(-1)! }));
  return [...records, ...short];
}

export function readWorkflowSkill(
  workflows: ResolvedWorkflow[],
  input: { name?: string; skillId?: string; path?: string },
): Record<string, unknown> | undefined {
  for (const workflow of workflows) {
    for (const skill of workflow.content.skills) {
      const name = `${workflow.alias}:${skill.name}`;
      const id = `workflow:${workflow.packageId}:${workflow.revisionId}:${skill.name}`;
      if (input.skillId ? input.skillId !== id : input.name !== name && input.name !== skill.name)
        continue;
      let resource = skill.path;
      if (input.path) {
        if (
          input.path.includes("\\") ||
          input.path.includes("\0") ||
          path.posix.isAbsolute(input.path)
        )
          return { error: "Invalid workflow resource path." };
        if (input.path.startsWith("skill://")) {
          const [target, ...rest] = input.path.slice(8).split("/");
          const sibling = workflow.content.skills.find((s) => s.name === target);
          if (!sibling) return { error: "Workflow skill not found." };
          resource = rest.length
            ? path.posix.join(path.posix.dirname(sibling.path), ...rest)
            : sibling.path;
        } else resource = path.posix.join(path.posix.dirname(skill.path), input.path);
      }
      if (resource === ".." || resource.startsWith("../") || resource.startsWith("/"))
        return { error: "Invalid workflow resource path." };
      const content = Object.hasOwn(workflow.content.files, resource)
        ? workflow.content.files[resource]
        : undefined;
      if (typeof content !== "string" || content.length > 100_000)
        return { error: "Workflow text resource is unavailable." };
      return {
        id,
        name,
        revisionId: workflow.revisionId,
        source: "plugin",
        readOnly: true,
        content,
        path: resource,
      };
    }
  }
  return undefined;
}

export function nativeWorkflowPackages(
  workflows: ResolvedWorkflow[],
): NonNullable<AgentRunRequest["workflowPackages"]> {
  const agentNames = new Set(["scout", "reviewer", "security-reviewer", "task", "sonic"]);
  return workflows.map((workflow) => {
    for (const agent of workflow.content.agents) {
      if (agentNames.has(agent.name))
        throw new Error(`Workflow agent name conflicts: ${agent.name}`);
      agentNames.add(agent.name);
    }
    return {
      id: workflow.packageId,
      alias: workflow.alias,
      files: workflow.content.files,
      skills: workflow.content.skills.map((s) => s.name),
      agents: workflow.content.agents.map((a) => a.name),
    };
  });
}
