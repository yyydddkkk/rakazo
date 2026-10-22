import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthCapabilities } from "./auth-capabilities";

let fetchAuthCapabilities: () => Promise<AuthCapabilities>;
beforeEach(async () => {
  vi.resetModules();
  ({ fetchAuthCapabilities } = await import("./auth-capabilities"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const capability = {
  passwordReset: false,
  resetUrl: null,
};
it("validates password recovery capabilities", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(capability)),
  );
  await expect(fetchAuthCapabilities()).resolves.toEqual(capability);
});
it.each([
  {},
  { passwordReset: "false", resetUrl: null },
  { passwordReset: false, resetUrl: "invalid" },
])("rejects malformed successful capabilities", async (body) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body)),
  );
  await expect(fetchAuthCapabilities()).rejects.toThrow();
});
it("rejects HTTP errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 503 })),
  );
  await expect(fetchAuthCapabilities()).rejects.toThrow();
});

it("shares a successful deployment lookup across callers", async () => {
  const fetch = vi.fn(async () => Response.json(capability));
  vi.stubGlobal("fetch", fetch);
  const first = fetchAuthCapabilities();
  expect(fetchAuthCapabilities()).toBe(first);
  await expect(first).resolves.toEqual(capability);
  await expect(fetchAuthCapabilities()).resolves.toEqual(capability);
  expect(fetch).toHaveBeenCalledOnce();
});

it("retries a failed deployment lookup", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json(capability));
  vi.stubGlobal("fetch", fetch);
  await expect(fetchAuthCapabilities()).rejects.toThrow();
  await expect(fetchAuthCapabilities()).resolves.toEqual(capability);
  expect(fetch).toHaveBeenCalledTimes(2);
});

function networkResponse(body: string, headers: Record<string, string>) {
  const response = new Response(body, { headers });
  vi.spyOn(response, "type", "get").mockReturnValue("basic");
  return response;
}

it("consumes a bounded uncompressed same-origin response natively", async () => {
  const body = JSON.stringify(capability);
  const response = networkResponse(body, { "content-length": String(body.length) });
  const arrayBuffer = vi.spyOn(response, "arrayBuffer");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  await expect(fetchAuthCapabilities()).resolves.toEqual(capability);
  expect(arrayBuffer).toHaveBeenCalledOnce();
});

it("rejects an oversized native body even if its declared length is small", async () => {
  const response = networkResponse(" ".repeat(64 * 1024 + 1), { "content-length": "1" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  await expect(fetchAuthCapabilities()).rejects.toThrow("Response body exceeds");
});

it("rejects malformed JSON in a bounded native response", async () => {
  const response = networkResponse("invalid", { "content-length": "7" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  await expect(fetchAuthCapabilities()).rejects.toBeInstanceOf(SyntaxError);
});

it.each<Record<string, string>>([
  {},
  { "content-length": "invalid" },
  { "content-length": "-1" },
  { "content-length": "1.5" },
  { "content-length": "1", "content-encoding": "gzip" },
])("bounds unknown or decoded response lengths while streaming: %j", async (headers) => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel,
    }),
    { headers },
  );
  vi.spyOn(response, "type", "get").mockReturnValue("basic");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  await expect(fetchAuthCapabilities()).rejects.toThrow("Response body exceeds");
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it("does not trust Content-Length on a synthetic response", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel,
    }),
    { headers: { "content-length": "1" } },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  await expect(fetchAuthCapabilities()).rejects.toThrow("Response body exceeds");
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it("times out while consuming a native network body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { headers: { "content-length": "1" } },
      );
      vi.spyOn(response, "type", "get").mockReturnValue("basic");
      return response;
    }),
  );
  const rejected = expect(fetchAuthCapabilities()).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(8_000);
  await rejected;
});
