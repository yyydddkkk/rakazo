// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Manual-only entry point runs outside Turbo tasks.
/** Manual-only model traffic meter. Never loaded by default tests or application startup. */
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";

const help = `Usage: pnpm exec tsx scripts/verify-omp-runner.ts

Requires MODEL_BASE_URL in the environment (an OpenAI-compatible upstream base URL).
Optionally set MODEL_API_KEY to inject its bearer credential, and MODEL_PROXY_PORT (8789).
No .env files are loaded. No prompt, response, headers, credentials or upstream URLs are logged.

Use http://127.0.0.1:8789/v1 as a temporary Rakazo model connection base URL.
Label subsequent calls before each Web run:
  curl --fail -X POST --data pi http://127.0.0.1:8789/__verification/runtime
  curl --fail -X POST --data omp http://127.0.0.1:8789/__verification/runtime

JSONL call records measure the actual outgoing tools array. Character counts sum each
compact JSON tool definition's JavaScript string length (UTF-16 units). See docs/omp-runner-design.md.
`;

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32 * 1024 * 1024) throw new Error("Request limit exceeded");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function reply(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(help);
    return;
  }
  if (!process.env.MODEL_BASE_URL) throw new Error("Set MODEL_BASE_URL before starting the meter");
  const upstreamBase = new URL(process.env.MODEL_BASE_URL);
  if (
    !["http:", "https:"].includes(upstreamBase.protocol) ||
    upstreamBase.username ||
    upstreamBase.password ||
    upstreamBase.search ||
    upstreamBase.hash
  ) {
    throw new Error("MODEL_BASE_URL must be an HTTP base URL without credentials or a query");
  }
  const port = Number(process.env.MODEL_PROXY_PORT ?? 8789);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid proxy port");
  let runtime: "pi" | "omp" | "unlabelled" = "unlabelled";
  let nextCallId = 0;
  const active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    active.add(controller);
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    let call: { runtime: typeof runtime; callId: number; startedAt: number } | undefined;
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      const body = await readBody(request);
      if (url.pathname === "/__verification/runtime" && request.method === "POST") {
        const label = body.toString("utf8").trim();
        if (label !== "pi" && label !== "omp") {
          reply(response, 400, "Expected pi or omp\n");
          return;
        }
        runtime = label;
        reply(response, 200, "Runtime label updated\n");
        return;
      }
      if (!url.pathname.startsWith("/v1/")) {
        reply(response, 404, "Unknown meter endpoint\n");
        return;
      }
      const target = new URL(upstreamBase);
      target.pathname = `${upstreamBase.pathname.replace(/\/$/, "")}/${url.pathname.slice(4)}`;
      target.search = url.search;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined ||
          ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(
            name,
          )
        )
          continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      if (process.env.MODEL_API_KEY)
        headers.set("authorization", `Bearer ${process.env.MODEL_API_KEY}`);
      if (request.method === "POST" && /\/(chat\/completions|responses)$/.test(url.pathname)) {
        const payload = JSON.parse(body.toString("utf8")) as { tools?: unknown };
        const tools = Array.isArray(payload.tools) ? payload.tools : [];
        call = { runtime, callId: ++nextCallId, startedAt: performance.now() };
        process.stdout.write(
          `${JSON.stringify({
            type: "model_call",
            runtime: call.runtime,
            callId: call.callId,
            toolCount: tools.length,
            toolDefinitionCharacters: tools.reduce(
              (sum, tool) => sum + JSON.stringify(tool).length,
              0,
            ),
          })}\n`,
        );
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: body.length ? new Uint8Array(body) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
      const outgoingHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (
          !["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)
        ) {
          outgoingHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, outgoingHeaders);
      let firstChunkMs: number | null = null;
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (call && firstChunkMs === null)
            firstChunkMs = Math.round(performance.now() - call.startedAt);
          if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
        }
      }
      response.end();
      if (call)
        process.stdout.write(
          `${JSON.stringify({
            type: "model_call_end",
            runtime: call.runtime,
            callId: call.callId,
            status: upstream.status,
            firstChunkMs,
            durationMs: Math.round(performance.now() - call.startedAt),
          })}\n`,
        );
    } catch {
      // Deliberately omit raw exception messages: upstream errors may contain credentials or URLs.
      if (call)
        process.stdout.write(
          `${JSON.stringify({ type: "model_call_failed", runtime: call.runtime, callId: call.callId })}\n`,
        );
      if (!response.headersSent) reply(response, 502, "Verification proxy request failed\n");
      else response.destroy();
    } finally {
      active.delete(controller);
    }
  });
  server.on("error", () => {
    process.stderr.write("Verification proxy could not listen\n");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const controller of active) controller.abort();
      server.close();
      server.closeAllConnections();
    });
  }
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `${JSON.stringify({ type: "meter_ready", baseUrl: `http://127.0.0.1:${port}/v1` })}\n`,
    );
  });
}

main().catch(() => {
  process.stderr.write("Verification proxy setup failed; use --help for required environment\n");
  process.exitCode = 1;
});
