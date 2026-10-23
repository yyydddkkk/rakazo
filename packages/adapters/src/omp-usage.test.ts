import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpUsageScope } from "./omp-usage.js";
import { OmpUsageJournal, recoverPendingOmpUsage } from "./omp-usage.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
const scope: OmpUsageScope = {
  spaceId: "space-fixture",
  userId: "user-fixture",
  runId: "run-fixture",
  botId: "bot-fixture",
  threadId: "thread-fixture",
};
const event: UsageEvent = {
  type: "usage",
  provider: "fixture",
  model: "fixture-model",
  callId: "run-fixture:main:message-1",
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 3,
  totalTokens: 15,
  costUsd: null,
  usageSource: "omp-rpc-v1",
  operationKind: "answer",
};
const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "rakazo-omp-usage-"));
  roots.push(directory);
  return directory;
}
async function entries(directory: string) {
  return (await readdir(join(directory, ".omp-usage"))).filter((name) => name.endsWith(".json"));
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("omp durable usage outbox", () => {
  it("persists independent usage while an earlier ledger callback is blocked", async () => {
    const directory = await root();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEntered!: () => void;
    const first = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondEntered!: () => void;
    const second = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const sink = vi.fn(async (received: UsageEvent) => {
      if (received.callId === event.callId) firstEntered();
      else secondEntered();
      await gate;
    });
    const journal = new OmpUsageJournal({ root: directory, scope, onUsage: sink });
    const a = journal.record(event);
    await first;
    const b = journal.record({ ...event, callId: "second-call" });
    const duplicate = journal.record(event);
    await second;
    expect(await entries(directory)).toHaveLength(2);
    release();
    await Promise.all([a, b]);
    expect(await duplicate).toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(await entries(directory)).toEqual([]);
  });

  it("persists before calling the sink and acknowledges once, independent of event consumption", async () => {
    const directory = await root();
    const sink = vi.fn(async (received: UsageEvent) => {
      const filenames = await entries(directory);
      expect(filenames).toHaveLength(1);
      const file = join(directory, ".omp-usage", filenames[0]!);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, scope, event });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(received).toEqual(event);
    });
    const journal = new OmpUsageJournal({ root: directory, scope, onUsage: sink });
    expect(await journal.record(event)).toEqual({ ...event, accounted: true });
    expect(await journal.record(event)).toBeUndefined();
    expect(sink).toHaveBeenCalledOnce();
    expect(await entries(directory)).toEqual([]);
  });

  it("bounds retries, retains only allowlisted fields, and replays after a new journal starts", async () => {
    const directory = await root();
    const unavailable = vi.fn().mockRejectedValue(new Error("provider output with fake-secret"));
    const journal = new OmpUsageJournal({ root: directory, scope, onUsage: unavailable });
    const extra = {
      ...event,
      prompt: "private prompt",
      apiKey: "fake-secret",
      raw: { token: "secret" },
    };
    await expect(journal.record(extra)).rejects.toThrow("retained for recovery");
    expect(unavailable).toHaveBeenCalledTimes(3);
    const file = join(directory, ".omp-usage", (await entries(directory))[0]!);
    const stored = await readFile(file, "utf8");
    expect(stored).not.toContain("private prompt");
    expect(stored).not.toContain("fake-secret");
    expect(stored).not.toContain("raw");
    const recovered = vi.fn();
    await new OmpUsageJournal({ root: directory, scope, onUsage: recovered }).drain();
    expect(recovered).toHaveBeenCalledExactlyOnceWith(event);
    expect(await entries(directory)).toEqual([]);
  });

  it("retries a commit-then-throw safely against a callId-idempotent persistent sink", async () => {
    const directory = await root();
    const ledger = new Map<string, UsageEvent>();
    let committed = false;
    const sink = vi.fn(async (received: UsageEvent) => {
      if (!ledger.has(received.callId!)) ledger.set(received.callId!, received);
      if (!committed) {
        committed = true;
        throw new Error("response lost after commit");
      }
    });
    const journal = new OmpUsageJournal({ root: directory, scope, onUsage: sink });
    expect(await journal.record(event)).toEqual({ ...event, accounted: true });
    expect(sink).toHaveBeenCalledTimes(2);
    expect([...ledger.values()]).toEqual([event]);
    expect(await entries(directory)).toEqual([]);
  });

  it("never reattributes an earlier run to the next run's bound sink", async () => {
    const directory = await root();
    const unavailable = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      new OmpUsageJournal({ root: directory, scope, onUsage: unavailable }).record(event),
    ).rejects.toThrow();
    const currentSink = vi.fn();
    const nextScope = {
      ...scope,
      spaceId: "another-space",
      userId: "another-user",
      runId: "another-run",
    };
    const next = new OmpUsageJournal({ root: directory, scope: nextScope, onUsage: currentSink });
    await next.drain();
    expect(currentSink).not.toHaveBeenCalled();
    expect(await entries(directory)).toHaveLength(1);
    const recovery = vi.fn();
    await recoverPendingOmpUsage({ root: directory, recoverUsage: recovery });
    expect(recovery).toHaveBeenCalledExactlyOnceWith(event, scope);
    expect(await entries(directory)).toEqual([]);
  });

  it("preserves corrupt entries and fails without including their contents in errors", async () => {
    const directory = await root();
    await expect(
      new OmpUsageJournal({ root: directory, scope, onUsage: vi.fn().mockRejectedValue(0) }).record(
        event,
      ),
    ).rejects.toThrow();
    const filename = (await entries(directory))[0]!;
    await writeFile(join(directory, ".omp-usage", filename), '{"fake-secret": true}');
    const sink = vi.fn();
    await expect(recoverPendingOmpUsage({ root: directory, recoverUsage: sink })).rejects.toThrow(
      "omp usage recovery entry is invalid",
    );
    expect(sink).not.toHaveBeenCalled();
    expect(await entries(directory)).toEqual([filename]);
  });

  it("keeps event-based accounting when no producer sink is provided", async () => {
    const journal = new OmpUsageJournal({ root: await root(), scope });
    expect(await journal.record(event)).toEqual(event);
    expect(await journal.record(event)).toBeUndefined();
  });

  it("bounds the time spent waiting for a callback that never settles", async () => {
    const directory = await root();
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sink = vi.fn(() => {
      entered();
      return new Promise<void>(() => undefined);
    });
    vi.useFakeTimers();
    const journal = new OmpUsageJournal({
      root: directory,
      scope,
      onUsage: sink,
      deliveryTimeoutMs: 10,
    });
    const recorded = journal.record(event);
    const rejected = expect(recorded).rejects.toThrow("retained for recovery");
    await called;
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(sink).toHaveBeenCalledTimes(3);
    expect(await entries(directory)).toHaveLength(1);
  });

  it("rejects oversized recovery files before sending anything to the sink", async () => {
    const directory = await root();
    await expect(
      new OmpUsageJournal({ root: directory, scope, onUsage: vi.fn().mockRejectedValue(0) }).record(
        event,
      ),
    ).rejects.toThrow();
    const filename = (await entries(directory))[0]!;
    await writeFile(join(directory, ".omp-usage", filename), "x".repeat(65_537));
    const sink = vi.fn();
    await expect(recoverPendingOmpUsage({ root: directory, recoverUsage: sink })).rejects.toThrow(
      "omp usage recovery entry is unavailable",
    );
    expect(sink).not.toHaveBeenCalled();
    expect(await entries(directory)).toEqual([filename]);
  });

  it.each([
    { inputTokens: undefined },
    { outputTokens: -1 },
    { cacheReadTokens: 1.5 },
    { totalTokens: 2_147_483_648 },
    { model: "x".repeat(2_049) },
    { operationKind: "unexpected" },
    { agentId: 42 },
  ])("rejects invalid recovered usage fields: %j", async (invalid) => {
    const directory = await root();
    await expect(
      new OmpUsageJournal({ root: directory, scope, onUsage: vi.fn().mockRejectedValue(0) }).record(
        event,
      ),
    ).rejects.toThrow();
    const filename = (await entries(directory))[0]!;
    await writeFile(
      join(directory, ".omp-usage", filename),
      JSON.stringify({ version: 1, scope, event: { ...event, ...invalid } }),
    );
    const sink = vi.fn();
    await expect(recoverPendingOmpUsage({ root: directory, recoverUsage: sink })).rejects.toThrow(
      "omp usage recovery entry is invalid",
    );
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects empty scope IDs before persisting usage", async () => {
    const directory = await root();
    const sink = vi.fn();
    const journal = new OmpUsageJournal({
      root: directory,
      scope: { ...scope, spaceId: "" },
      onUsage: sink,
    });
    await expect(journal.record(event)).rejects.toThrow("omp usage entry is invalid");
    expect(sink).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});
