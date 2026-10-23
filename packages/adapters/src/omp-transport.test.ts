import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { OmpProcess } from "./omp-transport.js";
import { LocalOmpTransport } from "./omp-transport.js";

const fixture = fileURLToPath(new URL("./test-support/omp-transport-process.mjs", import.meta.url));
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function start(mode: string) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-transport-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const child = await new LocalOmpTransport({
    executable: process.execPath,
    prefixArgs: [fixture, mode],
    closeGraceMs: 50,
    terminateGraceMs: 50,
    killGraceMs: 1000,
  }).start({ argv: [], cwd, env: {} });
  cleanups.push(() => child.terminate());
  return child;
}

async function ready(child: OmpProcess) {
  const reader = child.events[Symbol.asyncIterator]();
  let output = "";
  while (!output.includes("\n")) {
    const event = await reader.next();
    if (event.done) throw new Error("Fixture exited before ready");
    if (event.value.type === "stdout") output += Buffer.from(event.value.data).toString();
  }
  return { reader, pid: Number(JSON.parse(output.trim()).pid) };
}

describe("LocalOmpTransport cleanup", () => {
  it("forwards terminal usage during cooperative termination to the active reader", async () => {
    const child = await start("term-usage");
    const { reader } = await ready(child);
    const remaining = (async () => {
      const output = [];
      while (true) {
        const event = await reader.next();
        if (event.done) return output;
        output.push(event.value);
      }
    })();
    await child.terminate();
    const events = await remaining;
    expect(
      events
        .flatMap((event) => (event.type === "stdout" ? [Buffer.from(event.data).toString()] : []))
        .join(""),
    ).toBe(`${JSON.stringify({ type: "usage", input: 2, output: 3 })}\n`);
    expect(events.at(-1)).toEqual({ type: "exit", code: 0, signal: null });
  });

  it("drains discarded stdout once the reader returns during cleanup", async () => {
    const child = await start("term-usage");
    const { reader } = await ready(child);
    const ending = child.terminate();
    await reader.return?.();
    await ending;
    await child.exited;
  });
  it("accepts a cooperative TERM exit and rejects writes after close", async () => {
    const child = await start("term");
    const { reader } = await ready(child);
    await child.terminate();
    expect(await reader.next()).toEqual({
      value: { type: "exit", code: null, signal: "SIGTERM" },
      done: false,
    });
    await expect(child.writeStdin("ignored\n")).rejects.toThrow("stdin closed");
  });
  it("closes stdin and waits for a normal EOF exit", async () => {
    const child = await start("eof");
    const { reader } = await ready(child);
    await child.dispose();
    expect(await reader.next()).toEqual({
      value: { type: "exit", code: 0, signal: null },
      done: false,
    });
    expect((await reader.next()).done).toBe(true);
  });

  it("escalates ignored TERM to KILL and reuses the same termination", async () => {
    const child = await start("ignore-term");
    const { reader } = await ready(child);
    const first = child.terminate();
    expect(child.terminate()).toBe(first);
    await first;
    expect(await reader.next()).toEqual({
      value: { type: "exit", code: null, signal: "SIGKILL" },
      done: false,
    });
    expect((await reader.next()).done).toBe(true);
  });

  it("falls back from stdin EOF to bounded termination for a lingering process", async () => {
    const child = await start("ignore-term");
    const { reader } = await ready(child);
    await child.dispose();
    expect(await reader.next()).toEqual({
      value: { type: "exit", code: null, signal: "SIGKILL" },
      done: false,
    });
  });

  it.skipIf(process.platform === "win32")(
    "kills a descendant retaining stdout after the leader exits",
    async () => {
      const child = await start("leader-with-descendant");
      const { reader } = await ready(child);
      await child.terminate();
      expect(await reader.next()).toEqual({
        value: { type: "exit", code: null, signal: "SIGTERM" },
        done: false,
      });
      expect((await reader.next()).done).toBe(true);
    },
  );
});
