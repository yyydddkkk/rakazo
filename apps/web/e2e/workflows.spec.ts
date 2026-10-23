import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  expandAdvancedSection,
  openUserSettings,
  setupAdmin,
} from "./helpers";

// UI-only fake RPC: installation and authorization are covered by offline service tests.
test("Space and bot workflow settings install, select, always use, disable and uninstall", async ({
  page,
}, testInfo) => {
  const entry = {
    id: "workflow-example",
    alias: "example",
    enabled: true,
    name: "Example workflow",
    version: "1.0.0",
    revisionId: "revision-example",
    commit: "a".repeat(40),
    digest: "b".repeat(64),
    url: "https://example.test/workflow.git",
    requestedRevision: "v1.0.0",
    packagePath: "",
    license: "MIT",
    omitted: ["scripts/build.sh"],
    skills: [{ name: "review", description: "Review work", path: "skills/review/SKILL.md" }],
    agents: [{ name: "reviewer", description: "Reviews work" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  let installed = false;
  let enabled = true;
  let selection = { packageIds: [] as string[], alwaysUse: [] as string[] };
  await page.route("**/rpc/workflows/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.split("/").at(-1);
    const input = route.request().postDataJSON()?.json;
    let json: unknown;
    switch (procedure) {
      case "list":
        json = installed ? [{ ...entry, enabled }] : [];
        break;
      case "install":
        expect(input).toEqual({ url: entry.url, revision: "v1.0.0" });
        installed = true;
        json = entry;
        break;
      case "getBot":
        json = selection;
        break;
      case "setBot":
        selection = { packageIds: input.packageIds, alwaysUse: input.alwaysUse };
        json = selection;
        break;
      case "setEnabled":
        enabled = input.enabled;
        json = { ...entry, enabled };
        break;
      case "remove":
        installed = false;
        selection = { packageIds: [], alwaysUse: [] };
        json = { ok: true };
        break;
      default:
        throw new Error(`Unexpected workflow procedure: ${procedure}`);
    }
    await route.fulfill({ json: { json } });
  });
  let scopedCatalogBotId: string | undefined;
  await page.route("**/rpc/agentSkills/list", async (route) => {
    const input = route.request().postDataJSON()?.json;
    scopedCatalogBotId = input?.botId;
    const json =
      input?.botId && enabled && selection.packageIds.includes(entry.id)
        ? [
            {
              id: "workflow-skill-example",
              name: "example:review",
              description: "Review work",
              source: "plugin",
            },
          ]
        : [];
    await route.fulfill({ json: { json } });
  });
  await setupAdmin(page, "workflow-settings@rakazo.test", "password12", "Workflow settings");
  await completeOnboarding(page);
  const botName = "Workflow bot";
  const botId = await createNamedBot(page, botName);
  const spaceSettings = await openUserSettings(page, "workflows");
  const space = spaceSettings.getByTestId("space-workflows");
  await space.getByRole("button", { name: "Install", exact: true }).click();
  await space.getByRole("textbox", { name: "Git URL", exact: true }).fill(entry.url);
  await space.getByRole("textbox", { name: "Commit or tag", exact: true }).fill("v1.0.0");
  await expect(space).toContainText("Third-party instructions can use this bot’s tools.");
  await space.getByRole("button", { name: "Install", exact: true }).last().click();
  await expect(space.getByRole("switch", { name: entry.name })).toBeChecked();
  await captureScreenshot(page, testInfo, "space-workflows");
  await spaceSettings.getByRole("button", { name: "Close user settings" }).click();

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expandAdvancedSection(settings.getByTestId("bot-settings-advanced"));
  await settings.getByRole("button", { name: "Workflows", exact: true }).click();
  const bot = settings.getByTestId("bot-workflows");
  await bot.getByRole("switch", { name: entry.name }).click();
  await expect(bot.getByRole("group", { name: "Always use" })).toBeVisible();
  await bot.getByRole("switch", { name: "review", exact: true }).click();
  await expect(bot.getByRole("switch", { name: "review", exact: true })).toBeChecked();
  expect(selection).toEqual({ packageIds: [entry.id], alwaysUse: ["example:review"] });
  await captureScreenshot(page, testInfo, "bot-workflows");
  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("/example:review");
  await expect(
    page.getByRole("button", { name: "Skill example:review", exact: true }),
  ).toBeVisible();
  expect(scopedCatalogBotId).toBe(botId);
  await composer.fill("");

  const reopened = await openUserSettings(page, "workflows");
  const manager = reopened.getByTestId("space-workflows");
  await manager.getByRole("switch", { name: entry.name }).click();
  await expect(manager.getByRole("switch", { name: entry.name })).not.toBeChecked();
  await manager.getByRole("button", { name: "Details", exact: true }).click();
  await expect(manager).toContainText("scripts/build.sh");
  await manager.getByRole("button", { name: "Uninstall", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(manager.getByRole("switch")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "workflows-uninstalled");
});
