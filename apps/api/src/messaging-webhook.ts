import type { MessagingSurface } from "@rakazo/adapter-kit";
import type { Hono } from "hono";

export const MESSAGING_WEBHOOK_BASE_PATH = "/api/v1/messaging/webhook";

/** Forward raw provider requests for adapter verification and downstream replay protection. */
export function mountMessagingWebhookRoutes(app: Hono, deps: { messaging: MessagingSurface }) {
  app.all(`${MESSAGING_WEBHOOK_BASE_PATH}/:provider`, async (c) => {
    const response = deps.messaging.handleWebhook(c.req.param("provider"), c.req.raw);
    if (!response) return c.json({ error: "Unknown provider" }, 404);
    return response;
  });
}
