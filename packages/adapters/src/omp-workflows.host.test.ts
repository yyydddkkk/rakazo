import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ompProcessCommand } from "./omp-transport.js";
import { prepareOmpWorkflows } from "./omp-workflows.js";

const execute = promisify(execFile);

// Host-only: this checks Linux mounts and user namespaces with Node, never omp or a model.
it.skipIf(process.platform !== "linux")(
  "enforces workflow projections and discovery masks in the actual bubblewrap command",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-mount-host-"));
    try {
      const temporary = join(root, "run");
      const cwd = join(root, "workspace");
      const home = join(temporary, "home");
      await mkdir(temporary);
      const isolation = await prepareOmpWorkflows(
        [
          {
            id: "fixture-package",
            alias: "fixture",
            skills: ["fixture"],
            agents: ["fixture-agent"],
            files: {
              "plugin.json": JSON.stringify({ name: "fixture", version: "1" }),
              "skills/fixture/SKILL.md": "Fixture skill",
              "agents/fixture-agent.md": "Fixture agent",
            },
          },
        ],
        temporary,
        cwd,
      );
      await mkdir(home);
      await mkdir(join(temporary, "agent"));
      await mkdir(join(cwd, ".omp", "agents"));
      await writeFile(join(cwd, ".omp", "agents", "rogue.md"), "Project rogue");
      await mkdir(join(root, ".omp", "agents"), { recursive: true });
      await writeFile(join(root, ".omp", "agents", "ancestor.md"), "Ancestor rogue");
      const protectedFiles = [
        join(temporary, "config.yml"),
        join(temporary, "agent", "models.yml"),
        join(temporary, "instructions.md"),
      ];
      for (const file of protectedFiles) await writeFile(file, "Trusted configuration");
      const spec = {
        cwd,
        workflowIsolation: isolation,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local", "state"),
        },
        argv: [],
      };
      const probe = `
        const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
        const cwd = ${JSON.stringify(cwd)}, temporary = ${JSON.stringify(temporary)};
        const roots = ${JSON.stringify(isolation.packageRoots)}, configRoot = ${JSON.stringify(isolation.configRoot)};
        function cannotWrite(file) {
          assert.throws(() => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,"Injected"); });
        }
        assert.equal(fs.existsSync(path.join(cwd,".omp/agents/rogue.md")),false);
        let nearest, current=cwd;
        for (;;) {
          const candidate=path.join(current,".omp/agents");
          if(fs.existsSync(candidate)){ nearest=candidate; break; }
          if(current===path.dirname(current))break;
          current=path.dirname(current);
        }
        assert.equal(nearest,path.join(cwd,".omp/agents"));
        assert.deepEqual(fs.readdirSync(nearest),[]);
        for (const file of ${JSON.stringify(protectedFiles)}) cannotWrite(file);
        for (const relative of ["skills/fixture/SKILL.md","agents/fixture-agent.md","plugin.json"]) {
          const file=path.join(roots[0],relative);
          cannotWrite(file);
          assert.throws(()=>fs.chmodSync(file,0o777));
        }
        cannotWrite(path.join(configRoot,"agents/injected.md"));
        cannotWrite(path.join(cwd,".omp/agents/injected.md"));
        cannotWrite(path.join(process.env.HOME,".omp/agent/agents/injected.md"));
        cannotWrite(path.join(process.env.XDG_DATA_HOME,"omp/plugins/installed_plugins.json"));
        cannotWrite(path.join(process.env.XDG_CONFIG_HOME,"omp/plugins/installed_plugins.json"));
        assert.equal(fs.existsSync(path.join(cwd,".omp/agents/injected.md")),false);
        fs.writeFileSync(path.join(cwd,"ordinary.txt"),"Workspace stays writable");
        console.log("workflow-mount-checks-passed");
      `;
      const command = ompProcessCommand({ ...spec, argv: ["-e", probe] }, process.execPath);
      const result = await execute(command.executable, command.argv, {
        cwd,
        env: spec.env,
        timeout: 10_000,
      });
      expect(result.stdout.trim()).toBe("workflow-mount-checks-passed");
      expect(await readFile(join(cwd, "ordinary.txt"), "utf8")).toBe("Workspace stays writable");
      expect(await readFile(join(cwd, ".omp", "agents", "rogue.md"), "utf8")).toBe("Project rogue");
      for (const file of protectedFiles)
        expect(await readFile(file, "utf8")).toBe("Trusted configuration");
      expect(
        await readFile(join(isolation.packageRoots[0]!, "skills", "fixture", "SKILL.md"), "utf8"),
      ).toBe("Fixture skill");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
