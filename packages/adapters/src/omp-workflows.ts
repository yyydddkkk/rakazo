import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { WORKFLOW_CONFIG_ROOTS } from "./omp-transport.js";

export const WORKFLOW_DISABLED_PROVIDERS = [
  "native",
  "omp-managed",
  "omp-plugins",
  "agent-plugins",
  "claude",
  "codex",
  "agents",
  "opencode",
  "github",
  "cursor",
  "gemini",
  "windsurf",
  "vscode",
  "mcp-json",
  "skillshare",
];

export async function prepareOmpWorkflows(
  packages: NonNullable<AgentRunRequest["workflowPackages"]>,
  temporary: string,
  cwd: string,
) {
  const configRoot = join(temporary, "empty-config");
  await mkdir(join(configRoot, "agents"), { recursive: true, mode: 0o700 });
  await mkdir(join(configRoot, "skills"), { mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  for (const name of WORKFLOW_CONFIG_ROOTS) {
    const target = join(cwd, name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    if (!(await lstat(target)).isDirectory())
      throw new Error("Workflow config root must be a directory.");
  }
  const packageRoots: string[] = [];
  const names = new Set<string>();
  for (const pkg of packages) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(pkg.id))
      throw new Error("Invalid workflow package identity.");
    const root = join(temporary, "workflows", pkg.id);
    if (packageRoots.includes(root)) throw new Error("Duplicate workflow package.");
    packageRoots.push(root);
    for (const [kind, list] of [
      ["skill", pkg.skills],
      ["agent", pkg.agents],
    ] as const)
      for (const name of list) {
        const key = `${kind}:${name.toLowerCase()}`;
        if (!/^[a-zA-Z0-9_-]+$/.test(name) || names.has(key))
          throw new Error("Invalid or conflicting workflow name.");
        names.add(key);
      }
    for (const [file, content] of Object.entries(pkg.files)) {
      if (
        file.includes("\\") ||
        file.includes("\0") ||
        posix.isAbsolute(file) ||
        posix.normalize(file) !== file ||
        file.split("/").includes("..")
      ) {
        throw new Error("Invalid workflow projection path.");
      }
      if (
        file !== "plugin.json" &&
        file !== ".omp-plugin/plugin.json" &&
        file !== ".claude-plugin/plugin.json" &&
        !/\.(md|txt)$/i.test(file) &&
        !/^(LICENSE|LICENCE|NOTICE|COPYING)(\.[\w-]+)?$/i.test(posix.basename(file))
      ) {
        throw new Error("Executable workflow resources are not allowed.");
      }
      const target = join(root, file);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o400, flag: "wx" });
    }
  }
  return { temporary, configRoot, packageRoots };
}
