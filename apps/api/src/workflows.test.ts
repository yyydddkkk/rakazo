import type { Actor, WorkflowPackageContent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowsService } from "./workflows.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
};
const content: WorkflowPackageContent = {
  name: "review",
  version: "1",
  license: "MIT",
  commit: "a".repeat(40),
  digest: "digest",
  transformVersion: "1",
  skills: [
    { name: "review", description: "Review", content: "Steps", path: "skills/review/SKILL.md" },
  ],
  agents: [],
  files: {},
  omitted: [],
};
function setup() {
  const row = {
    id: "pkg-1",
    ...actor,
    alias: "review",
    enabled: true,
    deletedAt: null,
    createdAt: new Date(0),
    activeRevision: {
      id: "rev-1",
      url: "https://example.test/repo",
      requestedRevision: "v1",
      packagePath: "",
      commit: content.commit,
      digest: content.digest,
      content,
      createdAt: new Date(0),
    },
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    workflowPackage: {
      findFirst: vi.fn().mockResolvedValue(row),
      create: vi.fn(),
      update: vi.fn(async ({ data }) => ({ ...row, ...data })),
    },
    workflowPackageRevision: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([{ id: "rev-1" }]),
      create: vi.fn(async ({ data }) => data),
    },
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1" }) },
    botWorkflowPackage: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    run: {
      findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    attempt: { updateMany: vi.fn() },
    task: { updateMany: vi.fn() },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (callback) => callback(tx)) };
  const install = vi.fn().mockResolvedValue(content);
  const cancelled = vi.fn();
  const removeFiles = vi.fn().mockResolvedValue(undefined);
  return {
    tx,
    row,
    install,
    cancelled,
    removeFiles,
    prisma,
    service: createWorkflowsService(
      prisma as unknown as PrismaClient,
      install,
      cancelled,
      removeFiles,
    ),
  };
}
describe("workflow service", () => {
  it("guards package and bot ownership", async () => {
    const { tx, service } = setup();
    tx.workflowPackage.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.setEnabled(actor, { packageId: "foreign", enabled: false }),
    ).rejects.toThrow();
    expect(tx.workflowPackage.update).not.toHaveBeenCalled();
    tx.bot.findFirst.mockResolvedValueOnce(null);
    await expect(service.getBot(actor, "foreign")).rejects.toThrow();
    expect(tx.botWorkflowPackage.findMany).not.toHaveBeenCalled();
  });
  it("installs without selecting any bot", async () => {
    const { tx, service } = setup();
    await service.install(actor, { url: "https://example.test/repo", revision: "v1" });
    expect(tx.workflowPackage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        alias: "review",
      }),
    });
    expect(tx.botWorkflowPackage.create).not.toHaveBeenCalled();
  });
  it("cancels runs on disable and retains immutable revisions on removal", async () => {
    const { tx, service, cancelled } = setup();
    await service.setEnabled(actor, { packageId: "pkg-1", enabled: false });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          userId: actor.userId,
          workflowSnapshot: { path: [], array_contains: [{ packageId: "pkg-1" }] },
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
    );
    expect(cancelled).toHaveBeenCalledWith(actor, ["run-1"]);
    await service.remove(actor, "pkg-1");
    expect(tx.workflowPackage.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { enabled: false, deletedAt: expect.any(Date) } }),
    );
  });
  it("rejects unavailable always-use keys and disabled packages", async () => {
    const { tx, row, service } = setup();
    await expect(
      service.setBot(actor, {
        botId: "bot-1",
        packageIds: [row.id],
        alwaysUse: ["review:missing"],
      }),
    ).rejects.toThrow("Choose always-use");
    tx.workflowPackage.findFirst.mockResolvedValueOnce({ ...row, enabled: false });
    await expect(
      service.setBot(actor, { botId: "bot-1", packageIds: [row.id], alwaysUse: [] }),
    ).rejects.toThrow("Enable the workflow");
    expect(tx.botWorkflowPackage.deleteMany).not.toHaveBeenCalled();
  });
  it("preserves active revision if update removes an always-use skill", async () => {
    const { tx, service, install } = setup();
    tx.botWorkflowPackage.findMany.mockResolvedValueOnce([{ alwaysUse: ["review:review"] }]);
    install.mockResolvedValueOnce({ ...content, skills: [], commit: "b".repeat(40) });
    await expect(
      service.updateVersion(actor, { packageId: "pkg-1", revision: "v2" }),
    ).rejects.toThrow("Remove unavailable");
    expect(tx.workflowPackage.update).not.toHaveBeenCalled();
    expect(tx.workflowPackageRevision.create).not.toHaveBeenCalled();
  });
  it("reuses a matching immutable revision and rejects digest drift", async () => {
    const { tx, service } = setup();
    tx.workflowPackageRevision.findUnique.mockResolvedValueOnce({
      id: "rev-1",
      digest: content.digest,
    });
    await service.updateVersion(actor, { packageId: "pkg-1", revision: "v1" });
    expect(tx.workflowPackageRevision.create).not.toHaveBeenCalled();
    tx.workflowPackageRevision.findUnique.mockResolvedValueOnce({ id: "rev-1", digest: "changed" });
    await expect(
      service.updateVersion(actor, { packageId: "pkg-1", revision: "v1" }),
    ).rejects.toThrow("changed for the pinned commit");
  });
  it("rejects workflow names that exceed the shared skill name limit", async () => {
    const { service } = setup();
    await expect(
      service.install(actor, {
        url: "https://example.test/repo",
        revision: "v1",
        alias: "a".repeat(80),
      }),
    ).rejects.toThrow("80 characters");
  });
  it("rejects conflicting native names for omp bots", async () => {
    const { tx, row, service } = setup();
    tx.bot.findFirst.mockResolvedValueOnce({ id: "bot-1", runtime: "omp" });
    tx.workflowPackage.findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, id: "pkg-2", alias: "other" });
    await expect(
      service.setBot(actor, { botId: "bot-1", packageIds: ["pkg-1", "pkg-2"], alwaysUse: [] }),
    ).rejects.toThrow("Workflow name conflict");
    expect(tx.botWorkflowPackage.deleteMany).not.toHaveBeenCalled();
  });
  it("projects only selected, enabled packages within the bot owner scope", async () => {
    const { tx, row, service } = setup();
    tx.botWorkflowPackage.findMany.mockResolvedValueOnce([{ packageId: row.id, package: row }]);
    expect(await service.skillsForBot(actor, "bot-1")).toEqual([
      expect.objectContaining({
        name: "review:review",
        source: "plugin",
        readOnly: true,
        id: "workflow:pkg-1:rev-1:review",
      }),
    ]);
    expect(tx.botWorkflowPackage.findMany).toHaveBeenCalledWith({
      where: {
        botId: "bot-1",
        package: { spaceId: actor.spaceId, userId: actor.userId, deletedAt: null, enabled: true },
      },
      include: { package: { include: { activeRevision: true } } },
    });
  });
  it("cleans staged files when installation cannot commit", async () => {
    const { tx, service, removeFiles, install } = setup();
    tx.workflowPackage.create.mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), { code: "P2002" }),
    );
    await expect(
      service.install(actor, { url: "https://example.test/repo", revision: "v1" }),
    ).rejects.toThrow("alias already exists");
    expect(removeFiles).toHaveBeenCalledWith(install.mock.calls[0][1]);
  });
  it("cleans a rejected update without deleting the active revision", async () => {
    const { tx, service, removeFiles, install } = setup();
    tx.botWorkflowPackage.findMany.mockResolvedValueOnce([{ alwaysUse: ["review:removed"] }]);
    await expect(
      service.updateVersion(actor, { packageId: "pkg-1", revision: "v2" }),
    ).rejects.toThrow("Remove unavailable");
    expect(removeFiles).toHaveBeenCalledWith(install.mock.calls[0][1]);
    expect(removeFiles.mock.calls[0][0].revisionId).not.toBe("rev-1");
    expect(tx.workflowPackage.update).not.toHaveBeenCalled();
  });
  it("cleans the redundant staged revision when reusing a stored commit", async () => {
    const { tx, service, removeFiles, install } = setup();
    tx.workflowPackageRevision.findUnique.mockResolvedValueOnce({
      id: "rev-1",
      digest: content.digest,
    });
    await service.updateVersion(actor, { packageId: "pkg-1", revision: "v1" });
    expect(removeFiles).toHaveBeenCalledWith(install.mock.calls[0][1]);
    expect(tx.workflowPackageRevision.create).not.toHaveBeenCalled();
  });
  it("waits for cancellation cleanup before deleting unreferenced revision files", async () => {
    const { service, cancelled, removeFiles } = setup();
    let finish!: () => void;
    cancelled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const removing = service.remove(actor, "pkg-1");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(removeFiles).not.toHaveBeenCalled();
    finish();
    await removing;
    expect(removeFiles).toHaveBeenCalledWith({
      spaceId: actor.spaceId,
      packageId: "pkg-1",
      revisionId: "rev-1",
    });
  });
  it("retains files referenced by run history after uninstall", async () => {
    const { tx, service, removeFiles } = setup();
    tx.run.count.mockResolvedValueOnce(1);
    await service.remove(actor, "pkg-1");
    expect(removeFiles).not.toHaveBeenCalled();
    expect(tx.run.count).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        workflowSnapshot: {
          path: [],
          array_contains: [{ packageId: "pkg-1", revisionId: "rev-1" }],
        },
      },
    });
  });
  it("cancels only the removed bot's package runs when deselecting", async () => {
    const { tx, service, cancelled } = setup();
    tx.botWorkflowPackage.findMany.mockResolvedValueOnce([{ packageId: "pkg-1", alwaysUse: [] }]);
    await service.setBot(actor, { botId: "bot-1", packageIds: [], alwaysUse: [] });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
        }),
      }),
    );
    expect(cancelled).toHaveBeenCalledWith(actor, ["run-1"]);
  });
  it.each(["skill", "agent", "bundled agent"])(
    "rejects an update introducing a %s name conflict before switching revisions",
    async (kind) => {
      const { tx, row, service, install, removeFiles } = setup();
      const updated = {
        ...content,
        commit: "b".repeat(40),
        skills: kind === "skill" ? content.skills : [],
        agents:
          kind === "skill"
            ? []
            : [
                {
                  name: kind === "bundled agent" ? "reviewer" : "helper",
                  description: "Help",
                  content: "Help",
                },
              ],
      };
      install.mockResolvedValueOnce(updated);
      tx.botWorkflowPackage.findMany
        .mockResolvedValueOnce([{ botId: "bot-1", alwaysUse: [] }])
        .mockResolvedValueOnce([
          {
            package: {
              ...row,
              alias: "other",
              activeRevision: {
                ...row.activeRevision,
                content: {
                  ...content,
                  agents: [{ name: "helper", description: "Help", content: "Help" }],
                },
              },
            },
          },
        ]);
      await expect(
        service.updateVersion(actor, { packageId: "pkg-1", revision: "v2" }),
      ).rejects.toThrow("Workflow name conflict");
      expect(tx.workflowPackage.update).not.toHaveBeenCalled();
      expect(tx.workflowPackageRevision.create).not.toHaveBeenCalled();
      expect(removeFiles).toHaveBeenCalledWith(install.mock.calls[0][1]);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    },
  );
  it("retains a previously selected disabled package while changing active choices", async () => {
    const { tx, row, service } = setup();
    tx.botWorkflowPackage.findMany.mockResolvedValueOnce([
      { packageId: "pkg-1", alwaysUse: ["review:review"] },
    ]);
    tx.workflowPackage.findFirst
      .mockResolvedValueOnce({ ...row, enabled: false })
      .mockResolvedValueOnce({ ...row, id: "pkg-2", alias: "other" });
    expect(
      await service.setBot(actor, {
        botId: "bot-1",
        packageIds: ["pkg-1", "pkg-2"],
        alwaysUse: ["review:review", "other:review"],
      }),
    ).toEqual({ packageIds: ["pkg-1", "pkg-2"], alwaysUse: ["review:review", "other:review"] });
    expect(tx.botWorkflowPackage.create).toHaveBeenCalledWith({
      data: { botId: "bot-1", packageId: "pkg-1", alwaysUse: ["review:review"] },
    });
    expect(tx.botWorkflowPackage.create).toHaveBeenCalledWith({
      data: { botId: "bot-1", packageId: "pkg-2", alwaysUse: ["other:review"] },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
  it("refuses a newly selected disabled package even when another disabled package was retained", async () => {
    const { tx, row, service } = setup();
    tx.botWorkflowPackage.findMany.mockResolvedValueOnce([{ packageId: "pkg-1", alwaysUse: [] }]);
    tx.workflowPackage.findFirst
      .mockResolvedValueOnce({ ...row, enabled: false })
      .mockResolvedValueOnce({ ...row, id: "pkg-2", alias: "other", enabled: false });
    await expect(
      service.setBot(actor, { botId: "bot-1", packageIds: ["pkg-1", "pkg-2"], alwaysUse: [] }),
    ).rejects.toThrow("Enable the workflow");
    expect(tx.botWorkflowPackage.deleteMany).not.toHaveBeenCalled();
    expect(tx.botWorkflowPackage.create).not.toHaveBeenCalled();
  });
});
