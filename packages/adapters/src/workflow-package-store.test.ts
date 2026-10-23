import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { WorkflowPackageGit } from "./workflow-package-store.js";
import { WorkflowPackageStore } from "./workflow-package-store.js";

const execute = promisify(execFile);
const temporary: string[] = [];
const scope = { spaceId: "space-a", packageId: "package-a", revisionId: "revision-a" };
const source = {
  url: "https://github.com/example/workflows",
  revision: "v1",
  packagePath: "bundle",
};
it("cancels a Git download once the monitored size bound is exceeded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-fetch-bound-"));
  temporary.push(root);
  let cancelled = false;
  const store = new WorkflowPackageStore({
    dataDir: root,
    git: async (args, cwd, signal) => {
      if (args[0] === "init") return "";
      if (args[0] !== "fetch" || !signal) throw new Error("Unexpected Git call");
      const pack = path.join(cwd, "oversize-pack");
      await writeFile(pack, "");
      await truncate(pack, 128 * 1024 * 1024 + 1);
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(new Error("Aborted fixture download"));
          },
          { once: true },
        ),
      );
    },
  });
  await expect(store.install(source, scope)).rejects.toThrow("download exceeds size limit");
  expect(cancelled).toBe(true);
});
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-store-test-"));
  temporary.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git: WorkflowPackageGit = async (args, cwd) =>
    (
      await execute("git", args, {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      })
    ).stdout;
  await git(["init", "--template=", "."], repo);
  const put = async (name: string, text: string) => {
    const file = path.join(repo, "bundle", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await put(
    "package.json",
    JSON.stringify({
      name: "fixture-workflow",
      version: "1.0.0",
      license: "MIT",
      pi: { skills: ["./skills"], extensions: ["./extension.js"] },
      scripts: { postinstall: "touch marker" },
    }),
  );
  await put(
    "skills/alpha/SKILL.md",
    "---\nname: alpha\ndescription: Alpha workflow\n---\nRead ../beta/references/guide.md.\n",
  );
  await put("skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta workflow\n---\nBeta\n");
  await put("skills/beta/references/guide.md", "A referenced guide.");
  await put("skills/alpha/run.sh", "touch marker");
  await put("extension.js", "throw new Error('must never run')");
  await put("hooks/start.md", "Hook must be omitted.");
  await put("LICENSE", "Fixture permission notice.");
  for (const name of ["reviewer", "planner"])
    await put(
      `agents/${name}.md`,
      `---\nname: ${name}\ndescription: Fixture agent\ntools: [read, glob, lsp, yield, secret_tool]\nmodel: unsafe-model\nspawns: true\n---\nAgent instructions.\n`,
    );
  const commit = async () => {
    await git(["add", "."], repo);
    await git(["commit", "-m", "fixture"], repo);
    return (await git(["rev-parse", "HEAD"], repo)).trim();
  };
  const first = await commit();
  await git(["tag", "v1"], repo);
  const injected: WorkflowPackageGit = (args, cwd) =>
    git(
      args.map((arg) => (arg === source.url ? repo : arg)),
      cwd,
    );
  const store = new WorkflowPackageStore({ dataDir: path.join(root, "data"), git: injected });
  return { root, repo, store, put, commit, first, git };
}

describe("WorkflowPackageStore", () => {
  it("imports pinned text and normalized agents without executable entries or side effects", async () => {
    const { store, first, root } = await fixture();
    const result = await store.install(source, scope);
    expect(result.commit).toBe(first);
    expect(result.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
    expect(result.files["skills/beta/references/guide.md"]).toBe("A referenced guide.");
    expect(result.files.LICENSE).toBe("Fixture permission notice.");
    expect((await lstat(path.join(store.projectionPath(scope), "LICENSE"))).mode & 0o777).toBe(
      0o444,
    );
    expect(result.files["extension.js"]).toBeUndefined();
    expect(result.files["skills/alpha/run.sh"]).toBeUndefined();
    expect(result.files["hooks/start.md"]).toBeUndefined();
    expect(result.files["package.json"]).toBeUndefined();
    expect(JSON.parse(result.files["plugin.json"]!)).toMatchObject({
      name: "fixture-workflow",
      version: "1.0.0",
    });
    for (const agent of result.agents) {
      const header = parse(agent.content.split("---")[1]!);
      expect(header).toMatchObject({
        tools: ["read", "glob", "lsp", "yield"],
        spawns: false,
        structured: true,
      });
      expect(header.model).toBeUndefined();
    }
    expect(result.omitted).toContain("package.json#scripts");
    await expect(readFile(path.join(root, "marker"))).rejects.toThrow();
    expect(await store.read(scope)).toEqual(result);
  });
  it("resolves tags once, permits explicit upgrades, and reimports a full pinned SHA", async () => {
    const { store, first, put, commit, git, repo } = await fixture();
    const installed = await store.install(source, scope);
    await put("skills/beta/references/guide.md", "Updated guide.");
    const second = await commit();
    await git(["tag", "-f", "v1"], repo);
    expect(await store.install(source, scope)).toEqual(installed);
    expect((await store.install(source, { ...scope, revisionId: "revision-b" })).commit).toBe(
      second,
    );
    expect(
      (await store.install({ ...source, revision: first }, { ...scope, revisionId: "revision-c" }))
        .commit,
    ).toBe(first);
    await expect(
      store.install({ ...source, revision: "main" }, { ...scope, revisionId: "revision-d" }),
    ).rejects.toThrow();
  });
  it("projects explicit alternate skill roots with native-compatible manifests and depth", async () => {
    const { store, put, commit } = await fixture();
    await put(
      "package.json",
      JSON.stringify({ name: "alternate", version: "1", omp: { skills: ["./workflows/custom"] } }),
    );
    await put(
      "workflows/custom/third/SKILL.md",
      "---\nname: third\ndescription: Alternate root\n---\nThird workflow",
    );
    let sha = await commit();
    const result = await store.install({ ...source, revision: sha }, scope);
    expect(result.skills.map((skill) => skill.path)).toEqual(["workflows/custom/third/SKILL.md"]);
    expect(result.files["skills/alpha/SKILL.md"]).toBeUndefined();
    const manifest = JSON.parse(result.files[".claude-plugin/plugin.json"]!);
    expect(manifest.skills).toEqual(["./workflows/custom"]);
    expect(result.files[".omp-plugin/plugin.json"]).toBe(
      result.files[".claude-plugin/plugin.json"],
    );
    await put(
      "workflows/custom/deep/nested/SKILL.md",
      "---\nname: nested\ndescription: Nested unsupported root\n---\nNested",
    );
    sha = await commit();
    await expect(
      store.install({ ...source, revision: sha }, { ...scope, revisionId: "nested" }),
    ).rejects.toThrow("immediate children");
  });
  it("detects changed, injected, and symlinked projection resources", async () => {
    const { store } = await fixture();
    await store.install(source, scope);
    const file = path.join(store.projectionPath(scope), "LICENSE");
    await chmod(file, 0o644);
    await writeFile(file, "Modified");
    await expect(store.read(scope)).rejects.toThrow("integrity");
    await writeFile(file, "Fixture permission notice.");
    await writeFile(path.join(store.projectionPath(scope), "extra.md"), "Injected");
    await expect(store.read(scope)).rejects.toThrow("integrity");
    await rm(path.join(store.projectionPath(scope), "extra.md"));
    await rm(file);
    await symlink("plugin.json", file);
    await expect(store.read(scope)).rejects.toThrow("integrity");
  });
  it("rejects source and scope escapes, non-public protocols, symlinks, and undeclared formats", async () => {
    const { store, put, commit, repo } = await fixture();
    for (const url of [
      "file:///tmp/repo",
      "https://user:secret@github.com/example/repo",
      "https://127.0.0.1/a/b",
      "https://github.com/a/b?x=1",
      "ext::bad",
    ])
      await expect(store.install({ ...source, url }, scope)).rejects.toThrow();
    await expect(store.install({ ...source, packagePath: "../bundle" }, scope)).rejects.toThrow(
      "path",
    );
    await expect(store.read({ ...scope, spaceId: "../other" })).rejects.toThrow("scope");
    await symlink("/etc/passwd", path.join(repo, "bundle", "skills", "escape.md"));
    let sha = await commit();
    await expect(store.install({ ...source, revision: sha }, scope)).rejects.toThrow("symlinks");
    await rm(path.join(repo, "bundle", "skills", "escape.md"));
    await put(
      "package.json",
      JSON.stringify({ name: "invalid", version: "1", pi: { skills: ["../escape"] } }),
    );
    sha = await commit();
    await expect(store.install({ ...source, revision: sha }, scope)).rejects.toThrow("path");
  });
  it("rejects case collisions and submodules and excludes executable Markdown", async () => {
    const { store, put, commit, git, repo, first } = await fixture();
    await put("skills/alpha/executable.md", "must not be projected");
    await chmod(path.join(repo, "bundle", "skills", "alpha", "executable.md"), 0o755);
    let sha = await commit();
    const result = await store.install({ ...source, revision: sha }, scope);
    expect(result.files["skills/alpha/executable.md"]).toBeUndefined();
    await put("license", "collision");
    sha = await commit();
    await expect(
      store.install({ ...source, revision: sha }, { ...scope, revisionId: "collision" }),
    ).rejects.toThrow("colliding");
    await rm(path.join(repo, "bundle", "license"));
    await commit();
    await git(["update-index", "--add", "--cacheinfo", `160000,${first},bundle/dependency`], repo);
    await git(["commit", "-m", "submodule fixture"], repo);
    sha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await expect(
      store.install({ ...source, revision: sha }, { ...scope, revisionId: "submodule" }),
    ).rejects.toThrow("submodules");
  });
  it("rejects oversized text and removes revisions without touching other scopes", async () => {
    const { store, put, commit } = await fixture();
    await store.install(source, scope);
    const other = { ...scope, spaceId: "space-b" };
    await store.install(source, other);
    await store.remove(scope);
    await store.remove(scope);
    await expect(store.read(scope)).rejects.toThrow();
    expect((await store.read(other)).skills).toHaveLength(2);
    await put("oversize.md", "x".repeat(512 * 1024 + 1));
    const sha = await commit();
    await expect(store.install({ ...source, revision: sha }, scope)).rejects.toThrow("size limit");
    await expect(store.read(scope)).rejects.toThrow();
  });
});
