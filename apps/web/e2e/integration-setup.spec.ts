import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, setupAdmin } from "./helpers";

test("direct MCP connects a catalog result and assigns it to the selected bot", async ({
  page,
}, testInfo) => {
  await setupAdmin(page, `direct-mcp-${Date.now()}@rakazo.test`, "password12", "MCP setup");
  await completeOnboarding(page);
  await page.route("**/rpc/capabilities/catalogSearch", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          results: [
            {
              domain: "notes.example.test",
              name: "Notes",
              description: "",
              pageUrl: null,
              surfaces: [
                {
                  kind: "mcp",
                  slug: "notes",
                  source: "https://mcp.example.test/mcp",
                  auth: null,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  let serverId = "";
  await page.route("**/rpc/mcp/oauth/begin", (route) => {
    serverId = route.request().postDataJSON().json.serverId;
    return route.fulfill({ json: { json: { status: "already_connected" } } });
  });
  await page.goto("/integrations/setup");
  await expect(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search apps", exact: true }).fill("Notes");
  await page.getByRole("button", { name: "Search integrations.sh", exact: true }).click();
  await expect(page.getByText("Notes", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Server URL" })).toBeHidden();
  const assigned = page.waitForResponse(
    (response) => response.url().includes("/rpc/mcp/assignments/approve") && response.ok(),
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
  expect((await assigned).request().postDataJSON().json.serverId).toBe(serverId);
  await captureScreenshot(page, testInfo, "mcp-catalog-connected");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();
});

test("connecting a saved MCP server saves its replacement token before authorization", async ({
  page,
}, testInfo) => {
  await setupAdmin(page, `saved-mcp-${Date.now()}@rakazo.test`, "password12", "MCP reuse");
  await completeOnboarding(page);
  const endpoint = "https://mcp.example.test/saved-mcp";
  const server = await rpc<{ id: string; revision: number }>(page, "mcp/servers/create", {
    slug: "saved-mcp",
    name: "Saved MCP",
    transport: "streamable_http",
    endpoint,
    secret: "fake-saved-token",
    headers: { "X-Test": "fake-header" },
  });
  let saved = false;
  await page.route("**/rpc/mcp/servers/update", async (route) => {
    expect(route.request().postDataJSON().json).toEqual({
      id: server.id,
      secret: "fake-replacement-token",
    });
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const updated = (await response.json()).json;
    expect(updated.headerKeys).toEqual(["X-Test"]);
    expect(updated.revision).toBe(server.revision + 1);
    saved = true;
    await route.fulfill({ response });
  });
  await page.route("**/rpc/mcp/oauth/begin", (route) => {
    expect(saved).toBe(true);
    expect(route.request().postDataJSON().json.serverId).toBe(server.id);
    return route.fulfill({ json: { json: { status: "already_connected" } } });
  });
  let creates = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/mcp/servers/create")) creates += 1;
  });
  await page.goto("/integrations/setup");
  await page.getByText("Add server URL", { exact: true }).click();
  await page.getByRole("textbox", { name: "Server URL", exact: true }).fill(endpoint);
  await page.getByLabel("Access token (optional)", { exact: true }).fill("fake-replacement-token");
  const assigned = page.waitForResponse(
    (response) => response.url().includes("/rpc/mcp/assignments/approve") && response.ok(),
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await assigned;
  expect(creates).toBe(0);
  expect(saved).toBe(true);
  await expect(page.getByLabel("Access token (optional)", { exact: true })).toHaveValue("");
  await captureScreenshot(page, testInfo, "mcp-saved-connection");
});
