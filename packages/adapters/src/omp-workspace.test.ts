import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { selectOmpHostTools } from "./omp-runtime.js";
import { readOmpAttachment } from "./omp-workspace.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("offers only the supported product and fleet tools from Rakazo's builtin catalog", () => {
  expect(
    selectOmpHostTools(builtinAgentTools)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(
    [
      "message_user",
      "ask_user",
      "remember",
      "save_shared_memory",
      "search_history",
      "read_history",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "skill_read",
      "attach_file",
      "list_fleet",
      "create_group",
      "update_group",
      "organize_bot",
      "set_child_instructions",
      "set_child_bot_model",
      "create_child_routine",
      "spawn_bot",
      "update_bot",
      "archive_bot",
      "message_bot",
      "handoff_to_bot",
    ].sort(),
  );
});

it("reads local workspace attachments while rejecting escape paths and oversized files", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "omp-attachments-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "result.txt"), "result");
  await writeFile(path.join(root, "outside.txt"), "outside");
  await symlink(path.join(root, "outside.txt"), path.join(workspace, "link.txt"));
  expect(Buffer.from(await readOmpAttachment(workspace, "result.txt", 10)).toString()).toBe(
    "result",
  );
  await expect(readOmpAttachment(workspace, "../outside.txt", 10)).rejects.toThrow("inside");
  await expect(readOmpAttachment(workspace, "link.txt", 10)).rejects.toThrow("inside");
  await expect(readOmpAttachment(workspace, "result.txt", 2)).rejects.toThrow("size limit");
});
