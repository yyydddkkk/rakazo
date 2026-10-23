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
write({ type: "ready", protocolVersion: 1, maxFrameBytes: 1048576 });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "host_tool_result") {
    if (command.id !== "host-1") throw new Error("Wrong host correlation id");
    if (command.isError) throw new Error("Host call failed");
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
    if (scenario === "host" || scenario === "ask") {
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
      if (command.tools.some((tool) => ["shell", "spawn_bot"].includes(tool.name)))
        throw new Error("Unwanted host tool");
    }
    write({ type: "response", id: command.id, command: command.type, success: true });
  }
}
