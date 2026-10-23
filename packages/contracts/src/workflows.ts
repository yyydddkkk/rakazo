import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

const WorkflowSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
  path: z.string(),
});
const WorkflowAgentSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
});
export const WorkflowPackageContentSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string().nullable(),
  commit: z.string(),
  digest: z.string(),
  transformVersion: z.string(),
  skills: z.array(WorkflowSkillSchema),
  agents: z.array(WorkflowAgentSchema),
  files: z.record(z.string(), z.string()),
  omitted: z.array(z.string()),
});
export type WorkflowPackageContent = z.infer<typeof WorkflowPackageContentSchema>;
export const WorkflowPackageSchema = z.object({
  id: Id,
  alias: z.string(),
  enabled: z.boolean(),
  name: z.string(),
  version: z.string(),
  revisionId: Id,
  commit: z.string(),
  digest: z.string(),
  url: z.string(),
  requestedRevision: z.string(),
  packagePath: z.string(),
  license: z.string().nullable(),
  omitted: z.array(z.string()),
  skills: z.array(WorkflowSkillSchema.omit({ content: true })),
  agents: z.array(WorkflowAgentSchema.omit({ content: true })),
  createdAt: IsoDate,
});
export type WorkflowPackage = z.infer<typeof WorkflowPackageSchema>;
export const InstallWorkflowPackageInput = z.object({
  url: z.string().trim().min(1).max(2048),
  revision: z.string().trim().min(1).max(200),
  packagePath: z.string().trim().max(500).optional(),
  alias: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
    .optional(),
});
export const BotWorkflowsSchema = z.object({
  packageIds: z.array(Id).max(20),
  alwaysUse: z.array(z.string().min(1).max(80)).max(200),
});
export const SetBotWorkflowsInput = BotWorkflowsSchema.extend({ botId: Id });
