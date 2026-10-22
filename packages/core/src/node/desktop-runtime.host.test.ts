import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserCloseProgram,
  DEFAULT_DESKTOP_ENV,
  quiesceBrowserProfilesCommand,
} from "./desktop-runtime.js";

// These scan the real process table, so they run in the host group (pnpm test:host).
const JOINED_COMMAND = `import os, time
raw = open("/proc/self/cmdline", "rb").read().rstrip(b"\\0")
joined = raw.replace(b"\\0", b" ")
start = end = None
for line in open("/proc/self/maps"):
    if "[stack]" in line:
        a, b = line.split()[0].split("-")
        start, end = int(a, 16), int(b, 16)
        break
mem = os.open("/proc/self/mem", os.O_RDWR)
pos = end
found = None
while pos > start:
    size = min(1024 * 1024, pos - start)
    pos -= size
    os.lseek(mem, pos, os.SEEK_SET)
    data = os.read(mem, size + len(raw))
    idx = data.find(raw)
    if idx != -1:
        found = pos + idx
        break
if found is None:
    raise SystemExit("cmdline not found")
os.lseek(mem, found, os.SEEK_SET)
os.write(mem, joined)
os.close(mem)
open(os.environ["JOINED_READY"], "w").write("ready\\n")
time.sleep(120)
`;

function waitForReady(file: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (spawnSync("test", ["-s", file]).status === 0) return;
    spawnSync("sleep", ["0.02"]);
  }
  throw new Error("space-joined command line was not published");
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Chromium process quiesce on a real process table", () => {
  it.skipIf(process.platform !== "linux")(
    "quiesces the debugger-owning Chromium process and keeps cookie databases",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-quiesce-"));
      roots.push(root);
      const home = path.join(root, "home");
      const profiles = path.join(home, "team --type=renderer archive");
      const bin = path.join(root, "bin");
      const log = path.join(root, "closed");
      mkdirSync(bin);
      const sleeper = path.join(bin, "sleeper");
      writeFileSync(sleeper, "#!/usr/bin/env python3\nimport time\ntime.sleep(120)\n");
      chmodSync(sleeper, 0o755);
      writeFileSync(
        path.join(bin, "python3"),
        [
          "#!/bin/sh",
          'pid=""',
          'for arg in "$@"; do',
          '  case "$arg" in',
          "    ''|*[!0-9]*) ;;",
          "    *) pid=$arg ;;",
          "  esac",
          "done",
          'if [ -n "$pid" ]; then',
          '  printf "%s\\n" "$pid" >> "$QUIESCE_LOG"',
          '  kill "$pid" 2>/dev/null || true',
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(path.join(bin, "python3"), 0o755);
      const children: ChildProcess[] = [];
      const start = (directory: string, args: string[]) => {
        const cookies = path.join(directory, "Default", "Network", "Cookies");
        mkdirSync(path.dirname(cookies), { recursive: true });
        writeFileSync(cookies, "session=kept");
        const child = spawn(sleeper, args, {
          stdio: "ignore",
          detached: true,
        });
        children.push(child);
        return { child, cookies };
      };
      const botDir = path.join(profiles, "chromium-bot-abc");
      const primaryDir = path.join(profiles, "chromium");
      const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      const joiner = path.join(bin, "join-cmdline.py");
      writeFileSync(joiner, JOINED_COMMAND);
      const joinedDir = path.join(profiles, "chromium-screen-4");
      const joinedReady = path.join(root, "joined-ready");
      const joinedCookies = path.join(joinedDir, "Default", "Network", "Cookies");
      mkdirSync(path.dirname(joinedCookies), { recursive: true });
      writeFileSync(joinedCookies, "session=kept");
      const joined = spawn(
        python,
        [joiner, `--user-data-dir=${joinedDir}`, "--remote-debugging-port=9335"],
        { stdio: "ignore", detached: true, env: { ...process.env, JOINED_READY: joinedReady } },
      );
      children.push(joined);
      const launcher = spawn(
        "/bin/sh",
        [
          "-c",
          "sleep 120",
          "launcher",
          `--user-data-dir=${botDir}`,
          "--remote-debugging-port=9333",
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(launcher);
      const bot = start(botDir, [`--user-data-dir=${botDir}`, "--remote-debugging-port=9333"]);
      const botRenderer = start(botDir, [
        "--type=renderer",
        `--user-data-dir=${botDir}`,
        "--remote-debugging-port=9333",
      ]);
      const botHelper = start(botDir, [`--user-data-dir=${botDir}`]);
      const primary = start(primaryDir, [
        `--user-data-dir=${primaryDir}`,
        "--remote-debugging-port=9334",
      ]);
      try {
        const command = quiesceBrowserProfilesCommand({
          ...DEFAULT_DESKTOP_ENV,
          homeDir: home,
          workspaceDir: home,
          browserProfilesDir: profiles,
        }).replaceAll("/tmp/rakazo", path.join(root, "runtime"));
        expect(command).toContain("Browser.close");
        waitForReady(joinedReady);
        const result = spawnSync("bash", ["-eu", "-c", command], {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            QUIESCE_LOG: log,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        const closed = readFileSync(log, "utf8").trim().split("\n");
        expect(closed).toEqual(
          expect.arrayContaining([
            String(bot.child.pid),
            String(primary.child.pid),
            String(joined.pid),
          ]),
        );
        expect(closed).not.toContain(String(botRenderer.child.pid));
        expect(closed).not.toContain(String(botHelper.child.pid));
        expect(closed).not.toContain(String(launcher.pid));
        expect(spawnSync("kill", ["-0", String(botRenderer.child.pid)]).status).toBe(0);
        expect(spawnSync("kill", ["-0", String(botHelper.child.pid)]).status).toBe(0);
        expect(readFileSync(bot.cookies, "utf8")).toBe("session=kept");
        expect(readFileSync(primary.cookies, "utf8")).toBe("session=kept");
        expect(readFileSync(joinedCookies, "utf8")).toBe("session=kept");
      } finally {
        for (const child of children) {
          if (!child.pid) continue;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reads the debugging port from a space-joined Chromium command line",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-port-"));
      roots.push(root);
      const ready = path.join(root, "ready");
      const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      const joiner = path.join(root, "join-cmdline.py");
      writeFileSync(joiner, JOINED_COMMAND);
      const child = spawn(
        python,
        [
          joiner,
          "--user-data-dir=/tmp/my --type=renderer --remote-debugging-port=1 profile",
          "--remote-debugging-port=9444",
        ],
        { stdio: "ignore", detached: true, env: { ...process.env, JOINED_READY: ready } },
      );
      try {
        waitForReady(ready);
        const result = spawnSync(
          python,
          [
            "-c",
            browserCloseProgram(),
            String(child.pid),
            "/tmp/my --type=renderer --remote-debugging-port=1 profile",
            "--print-port",
          ],
          {
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("9444");
      } finally {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    },
  );
});
