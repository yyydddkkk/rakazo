import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { OmpRpcRuntime, selectOmpHostTools } from "./omp-runtime.js";
import type { OmpProcess, OmpTransport } from "./omp-transport.js";
import { LocalOmpTransport } from "./omp-transport.js";

const roots: string[] = [];
const fixture = fileURLToPath(new URL("./test-support/omp-rpc-process.mjs", import.meta.url));
const request = (): AgentRunRequest => ({
  runId: "run-fixture",
  botId: "bot-fixture",
  threadId: "thread-fixture",
  instructions: "You are a fixture bot.",
  prompt: "Current prompt",
  history: [],
  tools: [],
  model: {
    provider: "openai-compatible",
    id: "fixture-model",
    apiKey: "fake-model-secret",
    baseUrl: "https://example.test/v1",
  },
});

async function runtime(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "rakazo-omp-test-"));
  roots.push(root);
  const local = new LocalOmpTransport({
    executable: process.execPath,
    prefixArgs: [fixture, scenario],
  });
  const sent: Array<Record<string, unknown>> = [];
  let launched: OmpProcess | undefined;
  const transport: OmpTransport = {
    async start(spec) {
      expect(spec.argv).not.toContain("fake-model-secret");
      expect(Object.keys(spec.env)).not.toContain("DATABASE_URL");
      // omp 18.12.6 rejects unknown built-in tool names at startup.
      expect(spec.argv[spec.argv.indexOf("--tools") + 1]?.split(",")).not.toContain("find");
      launched = await local.start(spec);
      const write = launched.writeStdin;
      launched.writeStdin = (data) => {
        sent.push(JSON.parse(data));
        return write(data);
      };
      return launched;
    },
  };
  return {
    runner: new OmpRpcRuntime({ workspaceRoot: root, transport }),
    root,
    sent,
    launched: () => launched,
  };
}

async function collect(runner: OmpRpcRuntime, input = request()): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runner.run(input, { spaceId: "space-fixture", userId: "user-fixture" }))
    events.push(event);
  return events;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OmpRpcRuntime v1", () => {
  it("streams text and turns, waits past agent_end/prompt_result for session_settled", async () => {
    const { runner, root } = await runtime("text");
    const events = await collect(runner);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Hello.Later.");
    expect(events.filter((event) => event.type === "turn")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(await readdir(join(root, "space-fixture"))).toEqual(["bot-fixture"]);
  });

  it("dispatches the registered host tool once with its route and correlates the result", async () => {
    const { runner, sent } = await runtime("host");
    const input = request();
    const route = { connectorId: "fixture", toolName: "remember" };
    input.tools = [
      { name: "remember", description: "Save memory", inputSchema: { type: "object" }, route },
    ];
    input.executeTool = vi.fn().mockResolvedValue({ saved: true });
    input.onToolCompleted = vi.fn();
    const events = await collect(runner, input);
    expect(input.executeTool).toHaveBeenCalledExactlyOnceWith(
      "remember",
      { content: "fixture memory", path: "facts.md" },
      "run-fixture:tool-1",
      route,
    );
    expect(sent.find((frame) => frame.type === "host_tool_result")).toMatchObject({
      id: "host-1",
      result: { content: [{ type: "text", text: '{"saved":true}' }] },
    });
    expect(input.onToolCompleted).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "tool")).toEqual([
      {
        type: "tool",
        name: "remember",
        args: { content: "fixture memory", path: "facts.md" },
        executionId: "run-fixture:tool-1",
      },
    ]);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Saved.Background finished.");
  });

  it("counts terminal message usage once and marks successful producer accounting", async () => {
    const { runner } = await runtime("duplicate");
    const input = request();
    input.onUsage = vi.fn();
    const events = await collect(runner, input);
    const usage = events.filter((event) => event.type === "usage");
    expect(input.onUsage).toHaveBeenCalledTimes(2);
    expect(usage).toHaveLength(2);
    expect(usage.find((event) => event.inputTokens === 3)).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
      totalTokens: 10,
      costUsd: null,
      accounted: true,
      provider: "openai-compatible",
      model: "fixture-model",
    });
    expect(new Set(usage.map((event) => event.callId)).size).toBe(2);
  });

  it("observes native tools without dispatching them to Rakazo", async () => {
    const { runner } = await runtime("native");
    const input = request();
    input.executeTool = vi.fn();
    const events = await collect(runner, input);
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "tool" && event.name === "bash")).toBe(true);
  });

  it("completes native execution when best-effort tool auditing fails", async () => {
    const { runner } = await runtime("native");
    const input = request();
    input.onToolCompleted = vi.fn().mockRejectedValue(new Error("Audit storage unavailable"));
    const events = await collect(runner, input);
    expect(input.onToolCompleted).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("sends abort and terminates the process group without a success event", async () => {
    const { runner, sent, launched } = await runtime("abort");
    const input = request();
    const events: AgentRuntimeEvent[] = [];
    const pending = (async () => {
      for await (const event of runner.run(input, {
        spaceId: "space-fixture",
        userId: "user-fixture",
      })) {
        events.push(event);
        if (event.type === "usage") await runner.abort(input.runId);
      }
    })();
    await expect(pending).rejects.toThrow("omp run aborted");
    expect(sent.some((frame) => frame.type === "abort")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(false);
    await launched()?.exited;
    await runner.abort(input.runId);
  });

  it("pauses ask_user using the product event, then closes the process", async () => {
    const { runner } = await runtime("ask");
    const input = request();
    input.tools = [{ name: "ask_user", description: "Ask", inputSchema: { type: "object" } }];
    const events = await collect(runner, input);
    expect(events.find((event) => event.type === "ask")).toEqual({
      type: "ask",
      text: "Choose?",
      actions: [
        { id: "choice-1", label: "One" },
        { id: "choice-2", label: "Two" },
      ],
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("surfaces the provider's error detail, redacted, when a model call fails", async () => {
    const { runner } = await runtime("model-error");
    const failure = await collect(runner).catch((error: unknown) => error);
    expect(String(failure)).toContain("omp model call failed: 400 Invalid schema");
    expect(String(failure)).not.toContain("fake-model-secret");
  });

  it("explains an early exit with the redacted stderr tail", async () => {
    const { runner } = await runtime("crash");
    const failure = await collect(runner).catch((error: unknown) => error);
    expect(String(failure)).toContain("exited before the session settled: Error: tool unavailable");
    expect(String(failure)).not.toContain("fake-model-secret");
  });

  it("registers provider-safe object schemas and only native tools omp ships", async () => {
    const { runner, sent } = await runtime("text");
    const input = request();
    const schedule = builtinAgentTools.find((tool) => tool.name === "schedule_create");
    if (!schedule) throw new Error("schedule_create is missing");
    // Its declared schema is a root oneOf, which providers reject as tool parameters.
    expect("type" in schedule.inputSchema).toBe(false);
    input.tools = [schedule];
    await collect(runner, input);
    const registered = sent.find((frame) => frame.type === "set_host_tools") as {
      tools: Array<{ name: string; parameters: { type?: string } }>;
    };
    expect(registered.tools.map((tool) => [tool.name, tool.parameters.type])).toEqual([
      ["schedule_create", "object"],
    ]);
  });

  it("redacts the key even across text deltas and never forwards stderr", async () => {
    const { runner } = await runtime("redact");
    const events = await collect(runner);
    expect(JSON.stringify(events)).not.toContain("fake-model-secret");
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toContain("Key: [redacted]");
  });

  it("replays historical roles as data and removes the duplicate current message", async () => {
    const { runner } = await runtime("history");
    const input = request();
    input.history = [
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: input.prompt },
    ];
    await collect(runner, input);
  });

  it.each(["error", "chunk"])(
    "fails rather than completing an unsupported/error %s frame",
    async (scenario) => {
      const { runner } = await runtime(scenario);
      await expect(collect(runner)).rejects.toThrow(
        scenario === "error" ? "omp prompt failed" : "Invalid omp RPC frame",
      );
    },
  );

  it("keeps only the prototype host allowlist and already-authorized application tools", () => {
    const tools = ["shell", "spawn_bot", "message_user", "remember", "mcp__fixture__read"].map(
      (name) => ({ name, description: name, inputSchema: {} }),
    );
    expect(selectOmpHostTools(tools).map((tool) => tool.name)).toEqual([
      "message_user",
      "remember",
      "mcp__fixture__read",
    ]);
  });
});
