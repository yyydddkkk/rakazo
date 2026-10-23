// Deterministic JSONL peer. No omp, Bun, model or network calls.
import { createInterface } from "node:readline";

const scenario = process.argv[2];
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const assistant = (id, text, tokens = 3) => {
  write({ type: "message_start", messageId: id, message: { role: "assistant" } });
  write({
    type: "message_update",
    messageId: id,
    assistantMessageEvent: { type: "text_delta", delta: text },
  });
  const end = {
    type: "message_end",
    messageId: id,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: {
        input: tokens,
        output: 2,
        cacheRead: 4,
        cacheWrite: 1,
        reasoningTokens: 1,
        totalTokens: tokens + 7,
      },
    },
  };
  write(end);
  if (scenario === "duplicate") write(end);
};
let promptId;
let fleetCall;
let fleetResults = 0;
write({ type: "ready", protocolVersion: 1, maxFrameBytes: 1048576 });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "host_tool_result") {
    if (command.id !== "host-1") throw new Error("Wrong host correlation id");
    if (command.isError) throw new Error("Host call failed");
    if (scenario.startsWith("fleet-")) {
      const result = JSON.parse(command.result.content[0].text);
      if (result.error) throw new Error("Fleet host call failed");
      if (++fleetResults === 1) {
        // Repeat a completed RPC request, not a new model intent.
        write(fleetCall);
      } else {
        write({
          type: "tool_execution_end",
          toolCallId: fleetCall.toolCallId,
          toolName: fleetCall.toolName,
          result: command.result,
        });
        assistant("answer", "Done.");
        write({ type: "prompt_result", id: promptId, status: "completed", sessionSettled: true });
        write({ type: "session_settled" });
      }
      continue;
    }
    const content = command.result.content[0].text;
    if (content !== '{"saved":true}') throw new Error("Wrong host result");
    write({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "remember",
      result: command.result,
    });
    assistant("answer", "Saved.");
    write({ type: "prompt_result", id: promptId, status: "completed", sessionSettled: false });
    // This output MUST survive the prompt outcome: the session has not settled.
    assistant("followup", "Background finished.", 5);
    write({ type: "session_settled" });
  } else if (command.type === "prompt") {
    promptId = command.id;
    if (scenario === "history") {
      if (
        !command.message.includes("Earlier answer") ||
        command.message.split("Current prompt").length !== 2
      ) {
        throw new Error("History or current prompt duplicated");
      }
    }
    write({ type: "response", id: command.id, command: "prompt", success: true });
    if (scenario.startsWith("fleet-")) {
      const replay = command.message.includes("Call each listed approved request exactly once");
      const toolName = {
        "fleet-list": "list_fleet",
        "fleet-approval": "create_group",
        "fleet-spawn": "spawn_bot",
      }[scenario];
      const args =
        scenario === "fleet-list"
          ? {}
          : scenario === "fleet-spawn"
            ? { name: "Scout" }
            : replay
              ? { name: "Model reconstruction", bot_names: ["Unknown"] }
              : { name: "Crew", bot_names: ["Alpha", "Beta"] };
      const toolCallId = replay ? "tool-replay" : "tool-1";
      write({ type: "tool_execution_start", toolCallId, toolName, args });
      fleetCall = { type: "host_tool_call", id: "host-1", toolCallId, toolName, arguments: args };
      write(fleetCall);
    } else if (scenario === "host" || scenario === "ask") {
      const toolName = scenario === "ask" ? "ask_user" : "remember";
      const args =
        scenario === "ask"
          ? { question: "Choose?", options: ["One", "Two"] }
          : { content: "fixture memory", path: "facts.md" };
      write({ type: "tool_execution_start", toolCallId: "tool-1", toolName, args });
      write({
        type: "host_tool_call",
        id: "host-1",
        toolCallId: "tool-1",
        toolName,
        arguments: args,
      });
    } else if (scenario === "abort") {
      assistant("waiting", "Waiting.");
    } else if (scenario === "error") {
      write({
        type: "prompt_result",
        id: command.id,
        status: "error",
        error: { message: process.env.RAKAZO_OMP_MODEL_KEY },
      });
    } else if (scenario === "model-error") {
      write({ type: "message_start", messageId: "failed", message: { role: "assistant" } });
      write({
        type: "message_end",
        messageId: "failed",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: `400 Invalid schema (key ${process.env.RAKAZO_OMP_MODEL_KEY})`,
        },
      });
    } else if (scenario === "crash") {
      process.stderr.write(`Error: tool unavailable (key ${process.env.RAKAZO_OMP_MODEL_KEY})\n`);
      process.exit(1);
    } else if (scenario === "chunk") {
      write({ type: "rpc_chunk", data: "not-supported" });
    } else if (scenario === "native") {
      write({
        type: "tool_execution_start",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "true" },
      });
      write({
        type: "tool_execution_end",
        toolCallId: "bash-1",
        toolName: "bash",
        result: { content: [] },
      });
      assistant("answer", "Done.");
      write({ type: "prompt_result", id: command.id, status: "completed", sessionSettled: true });
      write({ type: "session_settled" });
    } else {
      const secret = process.env.RAKAZO_OMP_MODEL_KEY;
      if (scenario === "redact") {
        process.stderr.write(secret);
        write({ type: "message_start", messageId: "answer", message: { role: "assistant" } });
        for (const delta of ["Key: ", secret.slice(0, 4), secret.slice(4)]) {
          write({
            type: "message_update",
            messageId: "answer",
            assistantMessageEvent: { type: "text_delta", delta },
          });
        }
      } else assistant("answer", "Hello.");
      write({ type: "agent_end", messages: [] });
      write({ type: "prompt_result", id: command.id, status: "completed", sessionSettled: false });
      assistant("later", "Later.", 5);
      write({ type: "session_settled" });
    }
  } else {
    if (command.type === "set_host_tools") {
      if (command.tools.some((tool) => tool.name === "shell"))
        throw new Error("Unwanted host tool");
      // Providers reject tool parameters whose root is not an object (e.g. a bare oneOf).
      if (command.tools.some((tool) => tool.parameters?.type !== "object"))
        throw new Error("Host tool parameters must be an object schema");
    }
    write({ type: "response", id: command.id, command: command.type, success: true });
  }
}
