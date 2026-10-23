import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { OmpRpcRuntime } from "./omp-runtime.js";
import { LocalOmpTransport, ompProcessCommand, WORKFLOW_CONFIG_ROOTS } from "./omp-transport.js";
import { prepareOmpWorkflows } from "./omp-workflows.js";

const roots: string[] = [];
const packages = [
  {
    id: "package-fixture",
    alias: "example",
    skills: ["review"],
    agents: ["fixture-agent"],
    files: {
      "plugin.json": JSON.stringify({ name: "example", version: "1" }),
      ".omp-plugin/plugin.json": JSON.stringify({ name: "example", version: "1" }),
      "skills/review/SKILL.md": "---\nname: review\ndescription: Review fixture\n---\nReview it.",
      "agents/fixture-agent.md":
        "---\nname: fixture-agent\ndescription: Review\nspawns: false\nstructured: true\n---\nReview it.",
    },
  },
];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("hands only explicit text roots to the offline RPC peer and keeps native task contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-rpc-"));
  roots.push(root);
  const local = new LocalOmpTransport({
    executable: process.execPath,
    prefixArgs: [
      fileURLToPath(new URL("./test-support/omp-rpc-process.mjs", import.meta.url)),
      "workflows",
    ],
  });
  const runner = new OmpRpcRuntime({
    workspaceRoot: root,
    transport: {
      async start(spec) {
        expect(spec.argv).toContain("--no-extensions");
        expect(spec.argv).toContain("--no-rules");
        expect(spec.argv).not.toContain("--no-skills");
        expect(spec.argv).not.toContain("--extension");
        const config = parse(await readFile(spec.argv[spec.argv.indexOf("--config") + 1]!, "utf8"));
        expect(config.task.isolation.enabled).toBe(false);
        expect(config.task.agentModelOverrides["fixture-agent"]).toBe("rakazo/fixture-model");
        expect(config.skills.includeSkills).toEqual(["review"]);
        expect(config.disabledProviders).toContain("omp-plugins");
        const isolation = spec.workflowIsolation!;
        expect(isolation.packageRoots).toHaveLength(1);
        expect(await readdir(join(isolation.configRoot, "agents"))).toEqual([]);
        const command = ompProcessCommand(spec, "omp");
        expect(command.executable).toBe("bwrap");
        for (const configRoot of WORKFLOW_CONFIG_ROOTS) {
          expect(command.argv).toContain(join(spec.cwd, configRoot));
          expect(command.argv).toContain(join(spec.env.HOME!, configRoot));
        }
        expect(command.argv).toContain("--ro-bind");
        expect(command.argv).toContain("--die-with-parent");
        // The deterministic peer checks the real generated files, not OS namespaces.
        return local.start({ ...spec, workflowIsolation: undefined });
      },
    },
  });
  const request: AgentRunRequest = {
    runId: "run-fixture",
    botId: "bot-fixture",
    threadId: "thread-fixture",
    instructions: "Fixture",
    prompt: "Current prompt",
    history: [],
    tools: [],
    model: {
      provider: "openai-compatible",
      id: "fixture-model",
      baseUrl: "https://example.test/v1",
    },
    workflowPackages: packages,
  };
  const events = [];
  for await (const event of runner.run(request, {
    spaceId: "space-fixture",
    userId: "user-fixture",
  }))
    events.push(event);
  expect(events.at(-1)).toEqual({ type: "done" });
});

it("refuses script resources, path escapes and config symlinks before starting a process", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-projection-"));
  roots.push(root);
  for (const file of ["scripts/install.sh", "../escape.md", "/escape.md", "skills/review/run.js"]) {
    const temp = await mkdtemp(join(root, "attempt-"));
    await expect(
      prepareOmpWorkflows(
        [{ ...packages[0]!, files: { [file]: "malicious" } }],
        temp,
        join(root, "bot"),
      ),
    ).rejects.toThrow();
  }
  const temp = await mkdtemp(join(root, "attempt-"));
  await symlink(root, join(root, "bot", ".github"));
  await symlink(root, join(root, "bot", ".omp-symlink"));
  await rm(join(root, "bot", ".omp"), { recursive: true, force: true });
  await symlink(root, join(root, "bot", ".omp"));
  await expect(prepareOmpWorkflows(packages, temp, join(root, "bot"))).rejects.toThrow("directory");
});
