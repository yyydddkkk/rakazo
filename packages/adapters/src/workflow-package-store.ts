import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkflowPackageContent } from "@rakazo/contracts";
import { WorkflowPackageContentSchema } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";

export type { WorkflowPackageContent } from "@rakazo/contracts";

import { parse, stringify } from "yaml";

export type WorkflowPackageSource = { url: string; revision: string; packagePath?: string };
export type WorkflowPackageScope = { spaceId: string; packageId: string; revisionId: string };
export type WorkflowPackageGit = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;
const execute = promisify(execFile);
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const MAX_FETCH = 128 * 1024 * 1024;
const TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "lsp",
  "eval",
  "web_search",
  "yield",
]);

/** No inherited Git configuration, credentials, filters, hooks, redirects or transport helpers. */
export const runWorkflowPackageGit: WorkflowPackageGit = async (args, cwd, signal) => {
  try {
    const result = await execute(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        ...args,
      ],
      {
        cwd,
        timeout: 60_000,
        signal,
        maxBuffer: MAX_TOTAL,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
          HOME: cwd,
          XDG_CONFIG_HOME: cwd,
        },
      },
    );
    return result.stdout;
  } catch {
    throw new Error("Workflow package Git operation failed.");
  }
};

function parseDocument(text: string, yaml = false): unknown {
  try {
    return yaml ? parse(text, { maxAliasCount: 0 }) : JSON.parse(text);
  } catch {
    throw new Error("Invalid workflow package document.");
  }
}

function relative(value: string): string {
  const clean = value.replace(/^\.\//, "");
  if (
    !clean ||
    clean.includes("\\") ||
    clean.includes("\0") ||
    clean.startsWith("/") ||
    clean.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid workflow package path.");
  return clean;
}
function digest(content: Omit<WorkflowPackageContent, "digest">): string {
  return createHash("sha256")
    .update(
      JSON.stringify(content, (_key, value: unknown) =>
        isObject(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      ),
    )
    .digest("hex");
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function textFile(name: string): boolean {
  return (
    /\.(md|txt)$/i.test(name) ||
    /^(license|licence|notice|copying)(\.[\w-]+)?$/i.test(path.posix.basename(name))
  );
}
async function treeBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    total += entry.isDirectory() ? await treeBytes(file) : (await lstat(file)).size;
  }
  return total;
}

export class WorkflowPackageStore {
  private readonly root: string;
  private readonly git: WorkflowPackageGit;
  constructor(options: { dataDir: string; git?: WorkflowPackageGit }) {
    this.root = path.resolve(options.dataDir, "workflow-packages");
    this.git = options.git ?? runWorkflowPackageGit;
  }
  private directory(scope: WorkflowPackageScope): string {
    const segments = [scope.spaceId, scope.packageId, scope.revisionId];
    if (segments.some((segment) => !/^[a-zA-Z0-9_-]{1,128}$/.test(segment)))
      throw new Error("Invalid workflow package scope.");
    return path.join(this.root, ...segments);
  }
  projectionPath(scope: WorkflowPackageScope): string {
    return path.join(this.directory(scope), "projection", "1");
  }
  async install(
    source: WorkflowPackageSource,
    scope: WorkflowPackageScope,
  ): Promise<WorkflowPackageContent> {
    const target = this.directory(scope);
    // An existing revision is immutable, including when its original tag has moved.
    try {
      await lstat(target);
      return await this.read(scope);
    } catch (error) {
      if (!(isObject(error) && error.code === "ENOENT")) throw error;
    }
    const url = new URL(source.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[\w-]+\/[\w.-]+(?:\.git)?$/.test(url.pathname)
    )
      throw new Error("Only public HTTPS GitHub repositories are supported.");
    const pinned = /^[a-f0-9]{40}$/i.test(source.revision);
    const tag = source.revision.replace(/^refs\/tags\//, "");
    if (
      !pinned &&
      (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(tag) ||
        tag.includes("..") ||
        tag.endsWith("/") ||
        tag === "HEAD" ||
        tag.startsWith("refs/") ||
        tag.endsWith(".lock"))
    )
      throw new Error("A full commit or explicit tag is required.");
    const prefix = source.packagePath ? `${relative(source.packagePath)}/` : "";
    const temp = await mkdtemp(path.join(tmpdir(), "workflow-package-"));
    let staging: string | undefined;
    try {
      await this.git(["init", "--bare", "--template=", "."], temp);
      let exceeded = false;
      let monitoring = false;
      const download = new AbortController();
      // shortcut: the download limit can overshoot between polls; use a filesystem quota for a hard cap.
      const monitor = setInterval(() => {
        if (monitoring) return;
        monitoring = true;
        void treeBytes(temp)
          .then((bytes) => {
            if (bytes > MAX_FETCH) {
              exceeded = true;
              download.abort();
            }
          })
          .catch(() => {})
          .finally(() => {
            monitoring = false;
          });
      }, 100);
      try {
        await this.git(
          [
            "fetch",
            "--depth=1",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            url.href,
            pinned ? source.revision : `refs/tags/${tag}`,
          ],
          temp,
          download.signal,
        );
      } catch (error) {
        if (exceeded) throw new Error("Workflow package download exceeds size limit.");
        throw error;
      } finally {
        clearInterval(monitor);
      }
      if (exceeded || (await treeBytes(temp)) > MAX_FETCH)
        throw new Error("Workflow package download exceeds size limit.");
      const commit = (await this.git(["rev-parse", "FETCH_HEAD^{commit}"], temp)).trim();
      if (!/^[a-f0-9]{40}$/.test(commit) || (pinned && commit !== source.revision.toLowerCase()))
        throw new Error("Workflow package commit mismatch.");
      const tree = await this.git(["ls-tree", "-rz", "-l", commit], temp);
      const entries = tree.split("\0").filter(Boolean);
      if (entries.length > 4000) throw new Error("Workflow package contains too many files.");
      const sourceFiles: Record<string, string> = Object.create(null);
      const omitted: string[] = [];
      const seen = new Set<string>();
      let total = 0;
      for (const entry of entries) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error("Invalid workflow package tree.");
        const [, mode, type, oid, size, repoPath] = match;
        if (!repoPath?.startsWith(prefix)) continue;
        const name = relative(repoPath.slice(prefix.length));
        if (seen.has(name.toLowerCase())) throw new Error("Workflow package has colliding paths.");
        seen.add(name.toLowerCase());
        if (mode !== "100644" || type !== "blob") {
          if (mode === "120000" || mode === "160000")
            throw new Error("Workflow packages cannot contain symlinks or submodules.");
          omitted.push(name);
          continue;
        }
        if (name !== "package.json" && !textFile(name)) {
          omitted.push(name);
          continue;
        }
        const bytes = Number(size);
        total += bytes;
        if (bytes > MAX_FILE || total > MAX_TOTAL)
          throw new Error("Workflow package text exceeds size limit.");
        const content = await this.git(["cat-file", "blob", oid!], temp);
        if (content.includes("\0") || content.includes("\ufffd"))
          throw new Error("Workflow package contains non-text resources.");
        sourceFiles[name] = content;
      }
      const manifest: unknown = parseDocument(sourceFiles["package.json"] ?? "null");
      if (
        !isObject(manifest) ||
        typeof manifest.name !== "string" ||
        typeof manifest.version !== "string"
      )
        throw new Error("Workflow package requires a package manifest.");
      const selected = manifest.omp ?? manifest.pi;
      if (
        !isObject(selected) ||
        !Array.isArray(selected.skills) ||
        !selected.skills.every((entry) => typeof entry === "string")
      )
        throw new Error("Workflow package requires explicit omp or pi skills.");
      const roots = selected.skills.map((entry) => relative(entry as string));
      const files: Record<string, string> = Object.create(null);
      const skills: WorkflowPackageContent["skills"] = [];
      const agents: WorkflowPackageContent["agents"] = [];
      const names = new Set<string>();
      for (const [name, content] of Object.entries(sourceFiles)) {
        if (name === "package.json") continue;
        if (
          /(^|\/)(hooks|extensions|node_modules|\.git|\.omp|\.pi|\.claude|\.cursor)(\/|$)/i.test(
            name,
          ) ||
          /(^|\/)(agents|claude)\.md$/i.test(name)
        ) {
          omitted.push(name);
          continue;
        }
        if (name.startsWith("agents/") && !/^agents\/[^/]+\.md$/i.test(name)) {
          omitted.push(name);
          continue;
        }
        if (/^agents\/[^/]+\.md$/i.test(name)) {
          const parsed = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
          const header: unknown = parsed ? parseDocument(parsed[1]!, true) : null;
          if (
            !isObject(header) ||
            typeof header.name !== "string" ||
            !/^[a-z0-9][a-z0-9-]{0,79}$/.test(header.name) ||
            typeof header.description !== "string"
          )
            throw new Error("Invalid workflow package agent.");
          const tools =
            typeof header.tools === "string"
              ? header.tools.split(",").map((tool) => tool.trim())
              : Array.isArray(header.tools)
                ? header.tools
                : [];
          const allowed = tools.filter(
            (tool): tool is string => typeof tool === "string" && TOOLS.has(tool),
          );
          const normalized: Record<string, unknown> = {
            name: header.name,
            description: header.description,
            tools: allowed,
            spawns: false,
          };
          if (allowed.includes("yield")) normalized.structured = true;
          if (["off", "minimal", "low", "medium", "high"].includes(String(header.thinking)))
            normalized.thinking = header.thinking;
          for (const key of Object.keys(header))
            if (!(key in normalized)) omitted.push(`${name}#${key}`);
          for (const tool of tools)
            if (!allowed.includes(String(tool))) omitted.push(`${name}#tool:${String(tool)}`);
          const agent = `---\n${stringify(normalized)}---\n${parsed![2]}`;
          if (names.has(`agent:${header.name}`))
            throw new Error("Duplicate workflow package agent.");
          names.add(`agent:${header.name}`);
          agents.push({ name: header.name, description: header.description, content: agent });
          files[name] = agent;
        } else {
          if (path.posix.basename(name) === "SKILL.md") {
            const declared = roots.filter((root) => name.startsWith(`${root}/`));
            if (!declared.length) {
              omitted.push(name);
              continue;
            }
            if (
              !declared.some((root) => {
                const parts = name.slice(root.length + 1).split("/");
                return parts.length === 1 || (parts.length === 2 && !parts[0]!.startsWith("."));
              })
            )
              throw new Error(
                "Workflow skills must be directly inside a declared directory or its immediate children.",
              );
            const parsed = parseSkillMd(content);
            if ("error" in parsed || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(parsed.name))
              throw new Error("Invalid workflow package skill.");
            if (names.has(`skill:${parsed.name}`))
              throw new Error("Duplicate workflow package skill.");
            names.add(`skill:${parsed.name}`);
            skills.push({
              name: parsed.name,
              description: parsed.description,
              content,
              path: name,
            });
          }
          files[name] = content;
        }
      }
      if (!skills.length) throw new Error("Workflow package contains no declared skills.");
      if (
        roots.some(
          (root) =>
            !skills.some((skill) => skill.path === root || skill.path.startsWith(`${root}/`)),
        )
      )
        throw new Error("Workflow package declares missing skills.");
      for (const key of Object.keys(manifest))
        if (!["name", "version", "license", "description", "omp", "pi"].includes(key))
          omitted.push(`package.json#${key}`);
      for (const key of Object.keys(selected))
        if (key !== "skills") omitted.push(`package.json#${manifest.omp ? "omp" : "pi"}.${key}`);
      files["plugin.json"] =
        files[".omp-plugin/plugin.json"] =
        files[".claude-plugin/plugin.json"] =
          JSON.stringify({
            name: manifest.name,
            version: manifest.version,
            skills: roots.map((root) => `./${root}`),
            agents: ["./agents"],
          });
      const base = {
        transformVersion: "1",
        name: manifest.name,
        version: manifest.version,
        license: typeof manifest.license === "string" ? manifest.license : null,
        commit,
        skills,
        agents,
        files,
        omitted: omitted.sort(),
      };
      const result = { ...base, digest: digest(base) };
      await mkdir(path.dirname(target), { recursive: true });
      staging = `${target}.${randomUUID()}.tmp`;
      await mkdir(staging);
      const write = async (folder: string, name: string, content: string) => {
        const file = path.join(staging!, folder, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content, { mode: 0o444 });
      };
      for (const [name, content] of Object.entries(sourceFiles))
        await write("source", name, content);
      for (const [name, content] of Object.entries(files))
        await write("projection/1", name, content);
      await write("", "manifest.json", JSON.stringify(result));
      await rename(staging, target);
      staging = undefined;
      return result;
    } finally {
      await rm(temp, { recursive: true, force: true });
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
  async read(scope: WorkflowPackageScope): Promise<WorkflowPackageContent> {
    const directory = this.directory(scope);
    const checked = WorkflowPackageContentSchema.safeParse(
      parseDocument(await readFile(path.join(directory, "manifest.json"), "utf8")),
    );
    if (!checked.success) throw new Error("Workflow package integrity check failed.");
    const content = checked.data;
    const { digest: expected, ...base } = content;
    if (digest(base) !== expected) throw new Error("Workflow package integrity check failed.");
    const projected = this.projectionPath(scope);
    const actual: string[] = [];
    const walk = async (root: string) => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Workflow package integrity check failed.");
        if (entry.isDirectory()) await walk(file);
        else actual.push(path.relative(projected, file));
      }
    };
    await walk(projected);
    if (actual.length !== Object.keys(content.files).length)
      throw new Error("Workflow package integrity check failed.");
    for (const name of actual) {
      if ((await readFile(path.join(projected, relative(name)), "utf8")) !== content.files[name])
        throw new Error("Workflow package integrity check failed.");
    }
    return content;
  }
  async remove(scope: WorkflowPackageScope): Promise<void> {
    await rm(this.directory(scope), { recursive: true, force: true });
  }
}
