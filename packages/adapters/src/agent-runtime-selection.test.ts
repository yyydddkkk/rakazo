import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentRuntimeSelection } from "./agent-runtime-selection.js";
import { OmpUsageJournal } from "./omp-usage.js";

it("defaults to Pi and shares selected instances across API/worker composition", () => {
  const selection = createAgentRuntimeSelection({ dataDir: "data" });
  expect(selection.runtime.describe().id).toBe("pi");
  expect(selection.runtimeFor(null)).toBe(selection.runtime);
  expect(selection.runtimeFor("pi")).toBe(selection.runtime);
  expect(selection.runtimeFor("omp").describe().id).toBe("omp");
  expect(selection.runtimeFor("omp")).toBe(selection.runtimeFor("omp"));
});

it("supports deployment omp and scripted defaults with explicit Pi overrides", () => {
  for (const defaultRuntime of ["omp", "scripted"]) {
    const selection = createAgentRuntimeSelection({ dataDir: "data", defaultRuntime });
    expect(selection.runtime.describe().id).toBe(defaultRuntime);
    expect(selection.runtimeFor(undefined)).toBe(selection.runtime);
    expect(selection.runtimeFor("pi").describe().id).toBe("pi");
  }
  expect(() => createAgentRuntimeSelection({ dataDir: "data", defaultRuntime: "unknown" })).toThrow(
    "Unsupported agent runtime",
  );
});

it("recovers pending omp usage with a Pi default without launching an omp process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rakazo-runtime-selection-"));
  try {
    const scope = {
      runId: "run-fixture",
      botId: "bot-fixture",
      threadId: "thread-fixture",
      spaceId: "space-fixture",
      userId: "user-fixture",
    };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture-model",
      callId: "run-fixture:main:message-fixture",
      inputTokens: 10,
      outputTokens: 2,
    };
    const journal = new OmpUsageJournal({
      root: join(directory, "omp-workspaces"),
      scope,
      onUsage: vi.fn().mockRejectedValue(new Error("storage unavailable")),
    });
    await expect(journal.record(event)).rejects.toThrow("retained for recovery");
    const recoverUsage = vi.fn();
    const selection = createAgentRuntimeSelection({ dataDir: directory, recoverUsage });
    expect(selection.runtime.describe().id).toBe("pi");
    await selection.recoverPendingUsage();
    expect(recoverUsage).toHaveBeenCalledExactlyOnceWith(event, scope);
    await selection.recoverPendingUsage();
    expect(recoverUsage).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
