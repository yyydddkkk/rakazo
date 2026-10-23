import type { SkillRecord } from "@rakazo/core";
import { formatSkillsCatalogInstruction } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { skillReadFromTool } from "./skill-tools.js";
import { WorkflowPackageStore } from "./workflow-package-store.js";
import type { ResolvedWorkflow } from "./workflow-runtime.js";
import {
  createWorkflowResolver,
  nativeWorkflowPackages,
  readWorkflowSkill,
  workflowSkillRecords,
} from "./workflow-runtime.js";

function workflow(packageId = "package-a", alias = "alpha"): ResolvedWorkflow {
  const skill = (name: string) => ({
    name,
    description: `${name} workflow`,
    path: `skills/${name}/SKILL.md`,
    content: `# ${name}`,
  });
  return {
    packageId,
    alias,
    revisionId: "revision-a",
    alwaysUse: ["first"],
    content: {
      name: "fixture",
      version: "1",
      license: "MIT",
      commit: "a".repeat(40),
      digest: "fixture-digest",
      transformVersion: "1",
      skills: [skill("first"), skill("second")],
      agents: [{ name: "fixture-agent", description: "An imported agent", content: "Agent body" }],
      files: {
        "skills/first/SKILL.md": "# first",
        "skills/second/SKILL.md": "# second",
        "skills/second/references/guide.md": "Sibling guide",
        LICENSE: "Permission notice",
      },
      omitted: [],
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("workflow runtime content", () => {
  it("keeps Rakazo's Interrogate short name while exposing pstack's namespaced skill", async () => {
    const installed = workflow();
    installed.content.skills = [
      {
        name: "interrogate",
        description: "Imported review",
        content: "Imported body",
        path: "skills/interrogate/SKILL.md",
      },
    ];
    installed.content.files = { "skills/interrogate/SKILL.md": "Imported body" };
    const existing = BUILTIN_AGENT_SKILLS.map((skill) => ({
      ...skill,
      source: "builtin" as const,
      readOnly: true,
    }));
    expect(workflowSkillRecords([installed], existing).map((skill) => skill.name)).toEqual([
      "alpha:interrogate",
    ]);
    const prisma = {
      agentSkill: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const owner = { spaceId: "space-a", userId: "user-a" };
    expect(
      await skillReadFromTool(prisma, owner, { name: "interrogate" }, [installed]),
    ).toMatchObject({ name: "Interrogate", source: "builtin" });
    expect(
      await skillReadFromTool(prisma, owner, { name: "alpha:interrogate" }, [installed]),
    ).toMatchObject({ source: "plugin", content: "Imported body" });
  });
  it("serves enabled package text through the shared Pi skill_read host tool", async () => {
    const prisma = {
      agentSkill: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const owner = { spaceId: "space-a", userId: "user-a" };
    const installed = workflow();
    const read = await skillReadFromTool(prisma, owner, { name: "alpha:first" }, [installed]);
    expect(read).toMatchObject({
      name: "alpha:first",
      content: "# first",
      source: "plugin",
      readOnly: true,
    });
    expect(prisma.agentSkill.findMany).not.toHaveBeenCalled();
    expect(
      await skillReadFromTool(prisma, owner, { skillId: String(read.id), path: "skill://second" }, [
        installed,
      ]),
    ).toMatchObject({ content: "# second", revisionId: "revision-a" });
    expect(await skillReadFromTool(prisma, owner, { skillId: String(read.id) }, [])).toHaveProperty(
      "error",
    );
  });
  it("exposes stable read-only identities and qualified plus unique short names", () => {
    const installed = workflow();
    const records = workflowSkillRecords([installed], []);
    expect(records.map((record) => record.name)).toEqual([
      "alpha:first",
      "alpha:second",
      "first",
      "second",
    ]);
    expect(records[0]).toMatchObject({
      id: "workflow:package-a:revision-a:first",
      source: "plugin",
      readOnly: true,
    });
    expect(readWorkflowSkill([installed], { name: "alpha:first" })).toMatchObject({
      id: records[0]!.id,
      name: "alpha:first",
      revisionId: "revision-a",
      source: "plugin",
      readOnly: true,
      content: "# first",
    });
    expect(
      readWorkflowSkill([installed], { skillId: records[0]!.id, name: "ignored" }),
    ).toMatchObject({ content: "# first" });
    expect(
      readWorkflowSkill([installed], { skillId: "workflow:package-a:old:first" }),
    ).toBeUndefined();
    expect(readWorkflowSkill([], { skillId: records[0]!.id })).toBeUndefined();
  });
  it("resolves skill URIs and sibling references within the selected revision", () => {
    const installed = workflow();
    for (const resource of [
      "skill://second/references/guide.md",
      "../second/references/guide.md",
    ]) {
      expect(readWorkflowSkill([installed], { name: "alpha:first", path: resource })).toMatchObject(
        {
          content: "Sibling guide",
          path: "skills/second/references/guide.md",
          revisionId: "revision-a",
        },
      );
    }
    expect(readWorkflowSkill([installed], { name: "first", path: "skill://second" })).toMatchObject(
      { content: "# second" },
    );
    expect(readWorkflowSkill([installed], { name: "first", path: "../../LICENSE" })).toMatchObject({
      content: "Permission notice",
    });
  });
  it("denies traversal, cross-package URIs, inherited object keys, and unavailable text", () => {
    const installed = workflow();
    const other = workflow("package-b", "beta");
    other.content.skills = [
      {
        name: "foreign",
        description: "Foreign",
        path: "skills/foreign/SKILL.md",
        content: "Foreign body",
      },
    ];
    other.content.files = { "skills/foreign/SKILL.md": "Foreign body" };
    for (const resource of [
      "../../../escape.md",
      "/etc/passwd",
      "..\\..\\escape",
      "bad\0path",
      "skill://foreign",
      "skill://beta:foreign",
      "missing.md",
      "../../constructor",
      "../../__proto__",
    ]) {
      expect(
        readWorkflowSkill([installed, other], { name: "alpha:first", path: resource }),
      ).toHaveProperty("error");
    }
    installed.content.files["skills/first/large.txt"] = "x".repeat(100_001);
    expect(readWorkflowSkill([installed], { name: "first", path: "large.txt" })).toHaveProperty(
      "error",
    );
    expect(
      readWorkflowSkill([other], { skillId: "workflow:package-a:revision-a:first" }),
    ).toBeUndefined();
  });
  it("rejects native skill and agent collisions rather than shadowing content", () => {
    const installed = workflow();
    const existing: SkillRecord = {
      name: "FIRST",
      description: "User skill",
      source: "user",
      readOnly: false,
      content: "User content",
    };
    expect(workflowSkillRecords([installed], [existing]).map((skill) => skill.name)).toEqual([
      "alpha:first",
      "alpha:second",
      "second",
    ]);
    expect(() => workflowSkillRecords([installed, workflow("package-b", "beta")], [])).toThrow(
      "conflicts",
    );
    expect(nativeWorkflowPackages([installed])).toEqual([
      {
        id: "package-a",
        alias: "alpha",
        files: installed.content.files,
        skills: ["first", "second"],
        agents: ["fixture-agent"],
      },
    ]);
    expect(() => nativeWorkflowPackages([installed, workflow("package-b", "beta")])).toThrow(
      "conflicts",
    );
    installed.content.agents[0]!.name = "scout";
    expect(() => nativeWorkflowPackages([installed])).toThrow("conflicts");
  });
  it("retains all workflow skills in a catalog beyond fifty entries", () => {
    const installed = workflow();
    installed.content.skills = Array.from({ length: 55 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Workflow ${index}`,
      content: `Body ${index}`,
      path: `skills/skill-${index}/SKILL.md`,
    }));
    const records = workflowSkillRecords([installed], []);
    const catalog = formatSkillsCatalogInstruction(records);
    expect(catalog).toContain("alpha:skill-0");
    expect(catalog).toContain("alpha:skill-54");
    expect(catalog).toContain("skill-54");
  });
});

function resolverFixture() {
  const installed = workflow();
  const run: { status: string; workflowSnapshot: unknown } = {
    status: "running",
    workflowSnapshot: null,
  };
  const pkg = {
    id: installed.packageId,
    spaceId: "space-a",
    userId: "user-a",
    enabled: true,
    deletedAt: null as Date | null,
    alias: installed.alias,
    activeRevisionId: installed.revisionId,
  };
  const selection = { packageId: pkg.id, alwaysUse: ["first"], package: pkg };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    run: {
      findFirst: vi.fn().mockResolvedValue(run),
      update: vi.fn().mockImplementation(async ({ data }) => {
        run.workflowSnapshot = data.workflowSnapshot;
        return run;
      }),
    },
    botWorkflowPackage: { findMany: vi.fn().mockResolvedValue([selection]) },
    workflowPackage: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          pkg.id === where.id && pkg.spaceId === where.spaceId && pkg.userId === where.userId
            ? pkg
            : null,
        ),
    },
    workflowPackageRevision: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => ({
        id: where.id,
        digest: installed.content.digest,
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  const read = vi
    .spyOn(WorkflowPackageStore.prototype, "read")
    .mockResolvedValue(installed.content);
  const resolve = createWorkflowResolver({ prisma, dataDir: "/tmp/workflow-runtime-fixture" });
  const scope = { id: "run-a", spaceId: "space-a", userId: "user-a", botId: "bot-a" };
  return { resolve, run, pkg, tx, scope, read, installed, selection };
}

describe("workflow run snapshots", () => {
  it("freezes the initial selection and reuses it across upgrades and preference changes", async () => {
    const { resolve, run, pkg, scope, read, selection, tx } = resolverFixture();
    expect((await resolve(scope))[0]).toMatchObject({
      revisionId: "revision-a",
      alwaysUse: ["first"],
    });
    expect(run.workflowSnapshot).toEqual([
      { packageId: "package-a", revisionId: "revision-a", alwaysUse: ["first"] },
    ]);
    pkg.activeRevisionId = "revision-b";
    selection.alwaysUse = ["second"];
    expect((await resolve(scope))[0]).toMatchObject({
      revisionId: "revision-a",
      alwaysUse: ["first"],
    });
    expect(read).toHaveBeenLastCalledWith({
      spaceId: "space-a",
      packageId: "package-a",
      revisionId: "revision-a",
    });
    expect(tx.run.update).toHaveBeenCalledTimes(1);
    expect(tx.run.findFirst).toHaveBeenCalledWith({ where: scope });
  });
  it("refuses disabled, deleted, unselected and foreign packages on retry", async () => {
    const { resolve, scope, pkg, tx, read } = resolverFixture();
    await resolve(scope);
    read.mockClear();
    pkg.enabled = false;
    await expect(resolve(scope)).rejects.toThrow("disabled");
    pkg.enabled = true;
    pkg.deletedAt = new Date(0);
    await expect(resolve(scope)).rejects.toThrow("uninstalled");
    pkg.deletedAt = null;
    pkg.spaceId = "space-b";
    await expect(resolve(scope)).rejects.toThrow("disabled");
    pkg.spaceId = scope.spaceId;
    pkg.userId = "user-b";
    await expect(resolve(scope)).rejects.toThrow("disabled");
    pkg.userId = scope.userId;
    tx.botWorkflowPackage.findMany.mockResolvedValue([]);
    await expect(resolve(scope)).rejects.toThrow("disabled");
    expect(read).not.toHaveBeenCalled();
  });
  it("rechecks package state after acquiring its lock instead of trusting an earlier selection", async () => {
    const { resolve, scope, pkg, tx, read, selection } = resolverFixture();
    tx.botWorkflowPackage.findMany.mockResolvedValue([{ ...selection, package: { ...pkg } }]);
    tx.$queryRaw.mockResolvedValueOnce([{ id: "bot-lock" }]).mockImplementationOnce(async () => {
      pkg.enabled = false;
      return [{ id: "package-lock" }];
    });
    await expect(resolve(scope)).rejects.toThrow("disabled");
    expect(read).not.toHaveBeenCalled();
    expect(tx.run.update).not.toHaveBeenCalled();
  });
  it("keeps an empty run snapshot empty when packages are selected later", async () => {
    const { resolve, scope, tx, run, selection, read } = resolverFixture();
    tx.botWorkflowPackage.findMany.mockResolvedValueOnce([]);
    expect(await resolve(scope)).toEqual([]);
    expect(run.workflowSnapshot).toEqual([]);
    tx.botWorkflowPackage.findMany.mockResolvedValue([selection]);
    expect(await resolve(scope)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(tx.run.update).toHaveBeenCalledTimes(1);
  });
  it("rejects cancelled/missing runs, unavailable revisions and altered stored content", async () => {
    const { resolve, scope, tx, run, read, installed } = resolverFixture();
    run.status = "cancelled";
    await expect(resolve(scope)).rejects.toThrow("unavailable");
    tx.run.findFirst.mockResolvedValueOnce(null);
    await expect(resolve(scope)).rejects.toThrow("unavailable");
    run.status = "running";
    tx.workflowPackageRevision.findFirst.mockResolvedValueOnce(null);
    await expect(resolve(scope)).rejects.toThrow("revision");
    read.mockResolvedValueOnce({ ...installed.content, digest: "tampered" });
    await expect(resolve(scope)).rejects.toThrow("integrity");
  });
});
