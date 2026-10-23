import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpRpcQueue } from "./omp-rpc-queue.js";
import type { OmpRpcRuntimeOptions } from "./omp-runtime.js";
import { OmpRpcRuntime } from "./omp-runtime.js";
import type { OmpProcessEvent, OmpTransport } from "./omp-transport.js";

type Frame = Record<string, unknown> & { type: string };
const context = { spaceId: "space-fixture", userId: "user-fixture" };
const roots: string[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const input = (): AgentRunRequest => ({
  runId: "run-fixture",
  botId: "bot-fixture",
  threadId: "thread-fixture",
  prompt: "Hello",
  instructions: "Fixture",
  history: [],
  tools: [],
  model: {
    provider: "openai-compatible",
    id: "fixture",
    baseUrl: "https://example.test/v1",
    apiKey: "fake-model-secret",
  },
});
const tool = { name: "remember", description: "Save", inputSchema: { type: "object" } };
const host = {
  type: "host_tool_call",
  id: "host-1",
  toolCallId: "tool-1",
  toolName: "remember",
  arguments: { content: "memory", path: "facts.md" },
};
const toolStart = {
  type: "tool_execution_start",
  toolCallId: "tool-1",
  toolName: "remember",
  args: host.arguments,
};
const toolEnd = {
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "remember",
  result: {},
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function chunks(frame: Frame): Frame[] {
  const bytes = Buffer.from(JSON.stringify(frame));
  const count = Math.ceil(bytes.length / (256 * 1024));
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "chunk-fixture",
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64"),
  }));
}

class Peer implements OmpTransport {
  sent: Frame[] = [];
  terminate = vi.fn(async () => this.close());
  dispose = vi.fn(async () => this.close());
  started = deferred<void>();
  prompt = deferred<string>();
  released = deferred<void>();
  queue = new OmpRpcQueue<OmpProcessEvent>();
  closed = false;
  delayStart = false;
  blockAbort = false;
  blockCommand?: string;
  ignoreCommand?: string;
  commandBlocked = deferred<void>();
  failCommand?: string;
  partialReady = false;
  negotiatedMetadata = false;
  onCommand?: (frame: Frame, peer: Peer) => void;
  constructor(private scenario: (peer: Peer, id: string) => void) {}

  feed(...frames: Frame[]) {
    this.queue.push({
      type: "stdout",
      data: Buffer.from(frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")),
    });
  }
  answer(id = "message-1", text = "Hello") {
    this.feed(
      { type: "message_start", messageId: id, message: { role: "assistant" } },
      {
        type: "message_update",
        messageId: id,
        assistantMessageEvent: { type: "text_delta", delta: text },
      },
      {
        type: "message_end",
        messageId: id,
        message: {
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text }],
          usage: { input: 3, output: 2, totalTokens: 5 },
        },
      },
    );
  }
  outcome(id: string) {
    return { type: "prompt_result", id, status: "completed", sessionSettled: false };
  }
  complete(id: string) {
    this.feed(this.outcome(id), { type: "session_settled" });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.push({ type: "exit", code: 0, signal: null });
    this.queue.close();
  }
  async start() {
    this.started.resolve();
    if (this.delayStart) await this.released.promise;
    const ready = {
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1048576,
      maxReassembledFrameBytes: 67108864,
    };
    if (this.partialReady) {
      this.queue.push({
        type: "stdout",
        data: Buffer.from(`${JSON.stringify(ready)}\n{"type":"available_`),
      });
      this.queue.push({ type: "stdout", data: Buffer.from('commands_update","commands":[]}\n') });
    } else this.feed(ready);
    const exited = deferred<void>();
    const originalClose = this.close.bind(this);
    this.close = () => {
      originalClose();
      exited.resolve();
    };
    return {
      events: this.queue.iterate(),
      exited: exited.promise,
      terminate: this.terminate,
      dispose: this.dispose,
      closeStdin: () => this.close(),
      writeStdin: async (line: string) => {
        const command = JSON.parse(line) as Frame;
        this.sent.push(command);
        this.onCommand?.(command, this);
        if (command.type === "abort" && this.blockAbort) return new Promise<void>(() => undefined);
        if (command.type === "host_tool_result") return;
        if (command.type === this.ignoreCommand) {
          this.commandBlocked.resolve();
          return;
        }
        if (command.type === "prompt") {
          this.prompt.resolve(String(command.id));
          this.scenario(this, String(command.id));
          return;
        }
        const response = {
          type: "response",
          id: command.id,
          command: command.type,
          success: command.type !== this.failCommand,
          ...(command.type === "negotiate_protocol" ? { data: { protocolVersion: 2 } } : {}),
        };
        if (command.type === "negotiate_protocol" && this.negotiatedMetadata) {
          this.feed(
            response,
            ...chunks({
              type: "available_commands_update",
              commands: [{ description: "x".repeat(1_100_000) }],
            }),
          );
        } else this.feed(response);
        if (command.type === this.blockCommand) {
          this.commandBlocked.resolve();
          return new Promise<void>(() => undefined);
        }
      },
    };
  }
}

async function setup(peer: Peer, options: Partial<OmpRpcRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-races-"));
  roots.push(root);
  return { root, runner: new OmpRpcRuntime({ workspaceRoot: root, transport: peer, ...options }) };
}
async function collect(runner: OmpRpcRuntime, request = input()) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runner.run(request, context)) events.push(event);
  return events;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("omp RPC lifecycle and accounting races", () => {
  it("negotiates v2 across partial startup reads and an ack coalesced with large chunks", async () => {
    const peer = new Peer((p, id) => {
      p.feed({ type: "response", id, success: true });
      p.answer();
      p.complete(id);
    });
    peer.partialReady = true;
    peer.negotiatedMetadata = true;
    const { runner } = await setup(peer);
    const events = await collect(runner);
    expect(peer.sent[0]).toMatchObject({ type: "negotiate_protocol", protocolVersion: 2 });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      usageSource: "omp-rpc-v2",
    });
  });

  it("reassembles a large Unicode assistant frame without duplicating terminal text", async () => {
    const text = "段落🙂".repeat(160_000);
    const peer = new Peer((p, id) => {
      p.feed(
        { type: "response", id, success: true },
        { type: "message_start", messageId: "large", message: { role: "assistant" } },
        ...chunks({
          type: "message_update",
          messageId: "large",
          assistantMessageEvent: { type: "text_delta", delta: text },
        }),
        ...chunks({
          type: "message_end",
          messageId: "large",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            usage: { input: 1, output: 2 },
          },
        }),
      );
      p.complete(id);
    });
    const { runner } = await setup(peer);
    const events = await collect(runner);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe(text);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
  });

  it("ignores startup quiescence and unrelated prompt outcomes", async () => {
    const peer = new Peer((p, id) => {
      p.feed({ type: "response", id, success: true }, p.outcome("another-prompt"));
      p.answer();
      p.complete(id);
    });
    peer.onCommand = (command, p) => {
      if (command.type === "set_host_tools") p.feed({ type: "session_settled" });
    };
    const { runner } = await setup(peer);
    expect((await collect(runner)).at(-1)).toEqual({ type: "done" });
  });

  it.each(["result-before-ack", "settled-before-result"])(
    "rejects invalid completion ordering: %s",
    async (kind) => {
      const peer = new Peer((p, id) =>
        p.feed(
          ...(kind === "result-before-ack"
            ? [p.outcome(id), { type: "response", id, success: true }]
            : [
                { type: "response", id, success: true },
                { type: "session_settled" },
                p.outcome(id),
              ]),
        ),
      );
      const { runner } = await setup(peer);
      await expect(collect(runner)).rejects.toThrow(
        kind === "result-before-ack" ? "preceded its acknowledgement" : "before the prompt result",
      );
      expect(peer.dispose).toHaveBeenCalled();
    },
  );

  it("does not let a late error in the settled batch become a successful run", async () => {
    const peer = new Peer((p, id) =>
      p.feed(
        { type: "response", id, success: true },
        p.outcome(id),
        { type: "session_settled" },
        { type: "notice", level: "error", message: "fake-model-secret" },
      ),
    );
    const { runner } = await setup(peer);
    await expect(collect(runner)).rejects.toThrow("omp session reported an error");
  });

  it("does not repeat terminal-only text or tool execution on duplicate frames", async () => {
    const peer = new Peer((p, id) => {
      p.feed(
        { type: "response", id, success: true },
        toolStart,
        host,
        host,
        {
          type: "message_end",
          messageId: "terminal",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Once" }],
            usage: { input: 1, output: 1 },
          },
        },
        {
          type: "message_end",
          messageId: "terminal",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Once" }],
            usage: { input: 1, output: 1 },
          },
        },
      );
    });
    peer.onCommand = (command, p) => {
      if (command.type === "host_tool_result") {
        p.feed(toolEnd);
        p.complete("run-fixture:prompt");
      }
    };
    const { runner } = await setup(peer);
    const request = input();
    request.tools = [tool];
    request.executeTool = vi.fn(async () => ({ saved: true }));
    const events = await collect(runner, request);
    expect(request.executeTool).toHaveBeenCalledOnce();
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Once");
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
  });

  it("keeps reading host calls while usage persistence is blocked and waits before done", async () => {
    const peer = new Peer((p, id) => {
      p.feed({ type: "response", id, success: true });
      p.answer();
      p.feed(toolStart, host);
    });
    peer.onCommand = (command, p) => {
      if (command.type === "host_tool_result") {
        p.feed(toolEnd);
        p.complete("run-fixture:prompt");
      }
    };
    const { runner } = await setup(peer);
    const request = input();
    request.tools = [tool];
    const toolCalled = deferred<void>();
    const ledger = deferred<void>();
    request.executeTool = vi.fn(async () => {
      toolCalled.resolve();
      return { saved: true };
    });
    request.onUsage = vi.fn(async () => ledger.promise);
    let done = false;
    const result = collect(runner, request).then((events) => {
      done = true;
      return events;
    });
    await toolCalled.promise;
    await flush();
    expect(done).toBe(false);
    ledger.resolve();
    const events = await result;
    expect(request.onUsage).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("cancels a pending host request without sending its late result or invoking it twice", async () => {
    const gate = deferred<void>();
    const called = deferred<void>();
    const peer = new Peer((p, id) =>
      p.feed(
        { type: "response", id, success: true },
        toolStart,
        host,
        { type: "host_tool_cancel", targetId: "host-1" },
        host,
        toolEnd,
        p.outcome(id),
        { type: "session_settled" },
      ),
    );
    const { runner } = await setup(peer);
    const request = input();
    request.tools = [tool];
    request.executeTool = vi.fn(async () => {
      called.resolve();
      await gate.promise;
      return { saved: true };
    });
    let done = false;
    const result = collect(runner, request).then((events) => {
      done = true;
      return events;
    });
    await called.promise;
    await flush();
    expect(done).toBe(false);
    gate.resolve();
    expect((await result).at(-1)).toEqual({ type: "done" });
    expect(request.executeTool).toHaveBeenCalledOnce();
    expect(peer.sent.some((frame) => frame.type === "host_tool_result")).toBe(false);
  });

  it("bounds a cancelled tool that never settles instead of completing early", async () => {
    vi.useFakeTimers();
    const called = deferred<void>();
    const peer = new Peer((p, id) =>
      p.feed(
        { type: "response", id, success: true },
        toolStart,
        host,
        { type: "host_tool_cancel", targetId: "host-1" },
        toolEnd,
        p.outcome(id),
        { type: "session_settled" },
      ),
    );
    const { runner } = await setup(peer, { settleTimeoutMs: 20 });
    const request = input();
    request.tools = [tool];
    request.executeTool = async () => {
      called.resolve();
      return new Promise(() => undefined);
    };
    const result = collect(runner, request);
    const rejected = expect(result).rejects.toThrow("unfinished work");
    await called.promise;
    await flush();
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
  });

  it("finishes accounting even when the consumer returns before the usage event", async () => {
    const ledger = deferred<void>();
    const entered = deferred<void>();
    const peer = new Peer((p, id) => {
      p.feed({ type: "response", id, success: true });
      p.answer();
    });
    const { runner } = await setup(peer);
    const request = input();
    request.onUsage = async () => {
      entered.resolve();
      await ledger.promise;
    };
    const iterator = runner.run(request, context)[Symbol.asyncIterator]();
    await iterator.next();
    const returned = iterator.return?.();
    await entered.promise;
    ledger.resolve();
    await returned;
    expect(peer.terminate).toHaveBeenCalledOnce();
  });

  it("retries failed accounting and keeps permanently failed usage durable for replay", async () => {
    const makePeer = () =>
      new Peer((p, id) => {
        p.feed({ type: "response", id, success: true });
        p.answer();
        p.complete(id);
      });
    const peer = makePeer();
    const { runner, root } = await setup(peer);
    const request = input();
    request.onUsage = vi.fn().mockRejectedValue(new Error("fake-model-secret"));
    await expect(collect(runner, request)).rejects.toThrow("retained for recovery");
    expect(request.onUsage).toHaveBeenCalledTimes(3);
    expect(
      (await readdir(join(root, ".omp-usage"))).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
    const recovered = vi.fn();
    const next = input();
    next.runId = "next-run";
    next.onUsage = vi.fn();
    const retry = new OmpRpcRuntime({
      workspaceRoot: root,
      transport: makePeer(),
      recoverUsage: recovered,
    });
    await collect(retry, next);
    expect(recovered).toHaveBeenCalledWith(
      expect.objectContaining({ callId: expect.any(String) }),
      expect.objectContaining({
        runId: request.runId,
        spaceId: context.spaceId,
        botId: request.botId,
      }),
    );
    expect(next.onUsage).toHaveBeenCalledOnce();
  });

  it("gives fresh process attempts distinct call IDs under the same run", async () => {
    const ids: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const peer = new Peer((p, id) => {
        p.feed({ type: "response", id, success: true });
        p.answer();
        p.complete(id);
      });
      const { runner } = await setup(peer);
      const request = input();
      request.onUsage = (event) => {
        ids.push(event.callId!);
      };
      await collect(runner, request);
    }
    expect(new Set(ids).size).toBe(2);
  });

  it("counts distinct child messages with identical timestamps and their actual model", async () => {
    const childStart = {
      type: "subagent_event",
      payload: {
        id: "helper",
        event: { type: "message_start", message: { role: "assistant", timestamp: 1 } },
      },
    };
    const childEnd = (tokens: number) => ({
      type: "subagent_event",
      payload: {
        id: "helper",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            timestamp: 1,
            provider: "openrouter",
            model: "fixture-helper",
            usage: { input: tokens, output: 2 },
          },
        },
      },
    });
    const peer = new Peer((p, id) => {
      p.feed(
        { type: "response", id, success: true },
        {
          type: "subagent_lifecycle",
          payload: { id: "helper", status: "started", agent: "helper" },
        },
        childStart,
        childEnd(4),
        childEnd(4),
        childStart,
        childEnd(5),
        {
          type: "subagent_lifecycle",
          payload: { id: "helper", status: "completed", agent: "helper" },
        },
      );
      p.complete(id);
    });
    const { runner } = await setup(peer);
    const usage = (await collect(runner)).filter((event) => event.type === "usage");
    expect(usage).toHaveLength(2);
    expect(usage.map((event) => event.inputTokens).sort()).toEqual([4, 5]);
    for (const event of usage)
      expect(event).toMatchObject({
        provider: "openrouter",
        model: "fixture-helper",
        operationKind: "subagent",
        agentId: "run-fixture:helper",
      });
  });

  it("cancels during transport startup before any prompt is sent", async () => {
    const peer = new Peer(() => undefined);
    peer.delayStart = true;
    const { runner } = await setup(peer);
    const controller = new AbortController();
    const result = (async () => {
      for await (const _event of runner.run(input(), { ...context, signal: controller.signal })) {
      }
    })();
    const rejected = expect(result).rejects.toThrow("omp run aborted");
    await peer.started.promise;
    controller.abort();
    peer.released.resolve();
    await rejected;
    expect(peer.sent.some((frame) => frame.type === "prompt")).toBe(false);
    expect(peer.terminate).toHaveBeenCalledOnce();
  });

  it("bounds abort writes when stdin no longer drains", async () => {
    vi.useFakeTimers();
    const peer = new Peer(() => undefined);
    peer.blockAbort = true;
    const { runner } = await setup(peer, { abortWriteTimeoutMs: 20 });
    const result = collect(runner);
    const rejected = expect(result).rejects.toThrow("omp run aborted");
    await peer.prompt.promise;
    const aborted = runner.abort("run-fixture");
    await vi.advanceTimersByTimeAsync(21);
    await aborted;
    await rejected;
    expect(peer.terminate).toHaveBeenCalledOnce();
  });

  it("does not hang configuration rejection or reuse its pending state in another run", async () => {
    const peer = new Peer(() => undefined);
    peer.failCommand = "set_host_tools";
    const nextPeer = new Peer((p, id) => {
      p.feed({ type: "response", id, success: true });
      p.answer();
      p.complete(id);
    });
    let first = true;
    const { runner } = await setup(peer, {
      transport: {
        start: async () => {
          const selected = first ? peer : nextPeer;
          first = false;
          return selected.start();
        },
      },
    });
    await expect(collect(runner)).rejects.toThrow("omp rejected an RPC command");
    expect(peer.dispose).toHaveBeenCalled();
    expect((await collect(runner)).at(-1)).toEqual({ type: "done" });
  });

  it("bounds an unacknowledged configuration command and clears its timers", async () => {
    vi.useFakeTimers();
    const peer = new Peer(() => undefined);
    peer.ignoreCommand = "set_host_tools";
    const { runner } = await setup(peer, { commandTimeoutMs: 20 });
    const rejected = expect(collect(runner)).rejects.toThrow("omp RPC command timed out");
    await peer.commandBlocked.promise;
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(peer.dispose).toHaveBeenCalled();
  });

  it("handles a rejected command while its stdin write is still blocked", async () => {
    vi.useFakeTimers();
    const peer = new Peer(() => undefined);
    peer.failCommand = peer.blockCommand = "set_host_tools";
    const { runner } = await setup(peer, { abortWriteTimeoutMs: 20 });
    const rejected = expect(collect(runner)).rejects.toThrow("omp rejected an RPC command");
    await peer.commandBlocked.promise;
    await flush();
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains terminal usage when a stalled consumer overflows the bounded event buffer", async () => {
    const peer = new Peer((p, id) => {
      p.feed(
        { type: "response", id, success: true },
        { type: "message_start", messageId: "overflow", message: { role: "assistant" } },
        ...Array.from({ length: 2100 }, () => ({
          type: "message_update",
          messageId: "overflow",
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        })),
        {
          type: "message_end",
          messageId: "overflow",
          message: { role: "assistant", usage: { input: 1, output: 2100 } },
        },
        p.outcome(id),
        { type: "session_settled" },
      );
    });
    const { runner } = await setup(peer);
    const recorded = deferred<void>();
    const request = input();
    request.onUsage = vi.fn(async () => {
      recorded.resolve();
    });
    const iterator = runner.run(request, context)[Symbol.asyncIterator]();
    await iterator.next();
    await recorded.promise;
    const remaining = (async () => {
      while (!(await iterator.next()).done) {}
    })();
    await expect(remaining).rejects.toThrow("buffer limit exceeded");
    expect(request.onUsage).toHaveBeenCalledOnce();
  });
});
