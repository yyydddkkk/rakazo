import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OmpRpcQueue } from "./omp-rpc-queue.js";

export type OmpProcessEvent =
  | { type: "stdout" | "stderr"; data: Uint8Array }
  | { type: "exit"; code: number | null; signal: string | null };

export interface OmpProcess {
  events: AsyncIterable<OmpProcessEvent>;
  writeStdin(data: string): Promise<void>;
  closeStdin(): void;
  terminate(): void;
  exited: Promise<void>;
}

export interface OmpTransport {
  start(spec: { argv: string[]; cwd: string; env: Record<string, string> }): Promise<OmpProcess>;
}

export function ompWorkspaceDirectory(root: string, spaceId: string, botId: string): string {
  if (![spaceId, botId].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("Invalid omp workspace identity");
  }
  return join(resolve(root), spaceId, botId);
}

/** Pipe transport only; the runtime owns all RPC semantics. No shell interpolation. */
export class LocalOmpTransport implements OmpTransport {
  constructor(private options: { executable?: string; prefixArgs?: string[] } = {}) {}

  async start(spec: Parameters<OmpTransport["start"]>[0]): Promise<OmpProcess> {
    await mkdir(spec.cwd, { recursive: true, mode: 0o700 });
    const queue = new OmpRpcQueue<OmpProcessEvent>();
    const child = spawn(
      this.options.executable ?? "omp",
      [...(this.options.prefixArgs ?? []), ...spec.argv],
      {
        cwd: spec.cwd,
        env: spec.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout.on("data", (data: Buffer) => queue.push({ type: "stdout", data }));
    // stderr is deliberately drained without logging raw provider/tool diagnostics.
    child.stderr.on("data", (data: Buffer) => queue.push({ type: "stderr", data }));
    child.stdin.on("error", () => undefined);
    const exited = new Promise<void>((done) => {
      child.once("close", (code, signal) => {
        queue.push({ type: "exit", code, signal });
        queue.close();
        done();
      });
    });
    await new Promise<void>((ready, reject) => {
      child.once("spawn", ready);
      child.once("error", () => {
        reject(
          new Error("Unable to start omp; install the supported omp executable on the worker"),
        );
      });
    });
    return {
      events: queue.iterate(),
      exited,
      writeStdin: (data) =>
        new Promise<void>((done, reject) => {
          child.stdin.write(data, (error) => {
            if (error) reject(new Error("omp stdin closed"));
            else done();
          });
        }),
      closeStdin: () => child.stdin.end(),
      terminate: () => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill("SIGTERM");
          else process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
    };
  }
}
