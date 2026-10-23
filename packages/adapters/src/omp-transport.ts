import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OmpRpcQueue } from "./omp-rpc-queue.js";

export type OmpProcessEvent =
  | { type: "stdout" | "stderr"; data: Uint8Array }
  | {
      type: "exit";
      code: number | null;
      signal: string | null;
      /** Last bytes of stderr, unredacted; the runtime redacts before surfacing it. */
      stderrTail?: string;
    };

export interface OmpProcess {
  events: AsyncIterable<OmpProcessEvent>;
  writeStdin(data: string): Promise<void>;
  closeStdin(): void;
  terminate(): Promise<void>;
  dispose(): Promise<void>;
  exited: Promise<void>;
}

export interface OmpTransport {
  start(spec: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    workflowIsolation?: { temporary: string; configRoot: string; packageRoots: string[] };
  }): Promise<OmpProcess>;
}

export const WORKFLOW_CONFIG_ROOTS = [
  ".omp",
  ".claude",
  ".codex",
  ".gemini",
  ".agents",
  ".agent",
  ".opencode",
  ".cursor",
] as const;

/** Mounts preserve native discovery while hiding ambient project definitions. */
export function ompProcessCommand(
  spec: Parameters<OmpTransport["start"]>[0],
  executable: string,
  prefixArgs: string[] = [],
): { executable: string; argv: string[] } {
  if (!spec.workflowIsolation) return { executable, argv: [...prefixArgs, ...spec.argv] };
  if (process.platform !== "linux") {
    throw new Error("omp workflows require Linux with bubblewrap");
  }
  const { temporary, configRoot, packageRoots } = spec.workflowIsolation;
  const { HOME: workflowHome } = spec.env;
  if (!workflowHome) throw new Error("Workflow processes require an isolated home.");
  return {
    executable: "bwrap",
    argv: [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      spec.cwd,
      spec.cwd,
      "--bind",
      temporary,
      temporary,
      "--ro-bind",
      configRoot,
      configRoot,
      ...["XDG_DATA_HOME", "XDG_CONFIG_HOME"].flatMap((key) =>
        spec.env[key] ? ["--ro-bind", configRoot, join(spec.env[key]!, "omp", "plugins")] : [],
      ),
      ...[spec.cwd, workflowHome].flatMap((base) =>
        WORKFLOW_CONFIG_ROOTS.flatMap((name) => ["--ro-bind", configRoot, join(base, name)]),
      ),
      ...[
        join(temporary, "config.yml"),
        join(temporary, "agent", "models.yml"),
        join(temporary, "instructions.md"),
      ].flatMap((file) => ["--ro-bind", file, file]),
      ...packageRoots.flatMap((root) => ["--ro-bind", root, root]),
      "--chdir",
      spec.cwd,
      "--",
      executable,
      ...prefixArgs,
      ...spec.argv,
    ],
  };
}

const STDERR_TAIL_CHARS = 2000;

export function ompWorkspaceDirectory(root: string, spaceId: string, botId: string): string {
  if (![spaceId, botId].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("Invalid omp workspace identity");
  }
  return join(resolve(root), spaceId, botId);
}

/** Pipe transport only; the runtime owns all RPC semantics. No shell interpolation. */
export class LocalOmpTransport implements OmpTransport {
  constructor(
    private options: {
      executable?: string;
      prefixArgs?: string[];
      closeGraceMs?: number;
      terminateGraceMs?: number;
      killGraceMs?: number;
    } = {},
  ) {}

  async start(spec: Parameters<OmpTransport["start"]>[0]): Promise<OmpProcess> {
    await mkdir(spec.cwd, { recursive: true, mode: 0o700 });
    const command = ompProcessCommand(
      spec,
      this.options.executable ?? "omp",
      this.options.prefixArgs,
    );
    const queue = new OmpRpcQueue<OmpProcessEvent>();
    const child = spawn(command.executable, command.argv, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let draining = false;
    let cleanupActive = false;
    let readerActive = false;
    child.stdout.on("data", (data: Buffer) => {
      if (draining) return;
      child.stdout.pause();
      queue.push({ type: "stdout", data });
    });
    // Never queue raw provider/tool diagnostics or allow stderr to block the process; keep a
    // bounded tail so an early exit can say why.
    let stderrTail = "";
    child.stderr.on("data", (data: Buffer) => {
      stderrTail = (stderrTail + data.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin.on("error", () => undefined);
    let closed = false;
    const exited = new Promise<void>((done) => {
      child.once("close", (code, signal) => {
        closed = true;
        queue.push({ type: "exit", code, signal, stderrTail: stderrTail || undefined });
        queue.close();
        done();
      });
    });
    await new Promise<void>((ready, reject) => {
      child.once("spawn", ready);
      child.once("error", () => {
        reject(
          new Error(
            spec.workflowIsolation
              ? "Unable to start omp workflows; Linux bubblewrap and user namespaces are required"
              : "Unable to start omp; install the supported omp executable on the worker",
          ),
        );
      });
    });
    const waitForExit = (timeoutMs: number) =>
      new Promise<boolean>((done) => {
        if (closed) return done(true);
        const timer = setTimeout(() => done(false), timeoutMs);
        void exited.then(() => {
          clearTimeout(timer);
          done(true);
        });
      });
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          if (!closed) child.kill(signal);
        } else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const drain = () => {
      draining = true;
      child.stdout.resume();
    };
    const beginCleanup = () => {
      cleanupActive = true;
      if (!readerActive) drain();
    };
    let termination: Promise<void> | undefined;
    const terminate = () => {
      termination ??= (async () => {
        beginCleanup();
        signalGroup("SIGTERM");
        await waitForExit(this.options.terminateGraceMs ?? 1000);
        // Signal the whole group even if its leader exited but descendants remain.
        signalGroup("SIGKILL");
        if (!(await waitForExit(this.options.killGraceMs ?? 1000))) {
          // A stalled consumer cannot keep inherited descriptors and cleanup alive forever.
          drain();
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          queue.close(new Error("omp process did not close after termination"));
          throw new Error("omp process did not close after termination");
        }
      })();
      return termination;
    };
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      disposal ??= (async () => {
        beginCleanup();
        child.stdin.end();
        if (!(await waitForExit(this.options.closeGraceMs ?? 1000))) await terminate();
        else signalGroup("SIGKILL");
      })();
      return disposal;
    };
    return {
      events: (async function* () {
        readerActive = true;
        try {
          child.stdout.resume();
          for await (const event of queue.iterate()) {
            yield event;
            if (!draining) child.stdout.resume();
          }
        } finally {
          readerActive = false;
          if (cleanupActive) drain();
        }
      })(),
      exited,
      writeStdin: (data) =>
        new Promise<void>((done, reject) => {
          if (closed || child.stdin.destroyed || child.stdin.writableEnded) {
            reject(new Error("omp stdin closed"));
            return;
          }
          child.stdin.write(data, (error) => {
            if (error) reject(new Error("omp stdin closed"));
            else done();
          });
        }),
      closeStdin: () => child.stdin.end(),
      terminate,
      dispose,
    };
  }
}
