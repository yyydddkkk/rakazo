import type { MessagingSurface } from "@rakazo/adapter-kit";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MESSAGING_WEBHOOK_BASE_PATH, mountMessagingWebhookRoutes } from "./messaging-webhook.js";

/**
 * The route is a thin pass-through: verification, parsing, and status
 * handling all live inside the surface's platform adapters (covered in
 * packages/adapters). These tests pin the routing contract only.
 */
function mount(respond?: (provider: string, request: Request) => Response) {
  const handleWebhook = vi.fn((provider: string, request: Request) => {
    if (provider !== "lark") return null;
    return Promise.resolve(respond?.(provider, request) ?? Response.json({ ok: true }));
  });
  const app = new Hono();
  mountMessagingWebhookRoutes(app, {
    messaging: { handleWebhook } as unknown as MessagingSurface,
  });
  return { app, handleWebhook };
}

function post(body: string) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  };
}

const payload = JSON.stringify({ message: "hi" });

describe("messaging webhook HTTP routes", () => {
  it("forwards the raw request to the surface under the :provider param", async () => {
    const { app, handleWebhook } = mount();
    const res = await app.request(`${MESSAGING_WEBHOOK_BASE_PATH}/lark`, post(payload));

    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    const [provider, request] = handleWebhook.mock.calls[0]! as [string, Request];
    expect(provider).toBe("lark");
    // The raw Request passes through untouched so platform adapters can
    // verify signatures against the exact body bytes and headers.
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(`${MESSAGING_WEBHOOK_BASE_PATH}/lark`);
    await expect(request.text()).resolves.toBe(payload);
  });

  it("returns 404 for a provider the surface does not host", async () => {
    const { app, handleWebhook } = mount();
    const res = await app.request(`${MESSAGING_WEBHOOK_BASE_PATH}/carrier-pigeon`, post(payload));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Unknown provider" });
    expect(handleWebhook).toHaveBeenCalledWith("carrier-pigeon", expect.any(Request));
  });

  it("does not mount the removed phone webhook path", async () => {
    const { app, handleWebhook } = mount();
    expect((await app.request("/api/v1/phone/webhook", post(payload))).status).toBe(404);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("returns the surface's response verbatim, including rejections", async () => {
    const { app } = mount(() => new Response("signature mismatch", { status: 401 }));
    const res = await app.request(`${MESSAGING_WEBHOOK_BASE_PATH}/lark`, post(payload));

    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toBe("signature mismatch");
  });
});
