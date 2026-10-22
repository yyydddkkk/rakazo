import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, setupAdmin } from "./helpers";

test("changing language updates settings overflow without resizing", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await setupAdmin(page, `settings-language-${stamp}@rakazo.test`, "password12", "Settings");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await page.setViewportSize({ width: 660, height: 700 });
  const nav = settings.getByTestId("settings-nav");
  const next = settings.getByRole("button", { name: "Next settings sections" });
  await expect.poll(() => nav.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(next).toBeHidden();

  const language = settings.getByTestId("ui-locale-select");
  await language.click();
  await page.getByRole("option", { name: "Deutsch", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Allgemein", exact: true })).toBeVisible();
  await expect(next).toBeVisible();
  await expect(next).toBeEnabled();
  await captureScreenshot(page, testInfo, "settings-tabs-language-overflow");

  await language.click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(next).toBeHidden();
});

test("narrow settings reveals the active section and offers scroll controls", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await setupAdmin(page, `settings-narrow-${stamp}@rakazo.test`, "password12", "Settings");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "usage");
  const nav = settings.getByTestId("settings-nav");
  const usage = settings.getByTestId("settings-nav-usage");
  const previous = settings.getByRole("button", { name: "Previous settings sections" });
  const next = settings.getByRole("button", { name: "Next settings sections" });

  for (const width of [560, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(usage).toHaveAttribute("aria-current", "page");
    // Deep links and resizing must reveal the whole selected section.
    await expect
      .poll(async () => {
        const viewport = await nav.boundingBox();
        const active = await usage.boundingBox();
        return Boolean(
          viewport &&
            active &&
            active.x >= viewport.x - 1 &&
            active.x + active.width <= viewport.x + viewport.width + 1,
        );
      })
      .toBe(true);
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();
    await captureScreenshot(page, testInfo, `settings-tabs-${width}`);
    const offset = await nav.evaluate((node) => node.scrollLeft);
    await previous.click();
    await expect.poll(() => nav.evaluate((node) => node.scrollLeft)).toBeLessThan(offset);
    await settings.getByTestId("settings-nav-general").click();
    await expect(settings).toHaveAttribute("data-settings-section", "general");
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(() => nav.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const header = settings.getByTestId("settings-header");
    const before = await header.boundingBox();
    await settings
      .getByRole("button", { name: "Delete account", exact: true })
      .scrollIntoViewIfNeeded();
    await expect
      .poll(() => settings.getByTestId("settings-scroll").evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    expect(await header.boundingBox()).toEqual(before);
    expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(settings.getByRole("button", { name: "Close user settings" })).toBeVisible();
    await captureScreenshot(page, testInfo, `settings-narrow-scrolled-${width}`);
    await usage.click();
    await expect(settings).toHaveAttribute("data-settings-section", "usage");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(previous).toBeHidden();
  await expect(next).toBeHidden();
  await expect(usage).toBeVisible();
  await expect(usage).toHaveAttribute("aria-current", "page");
});

test("settings shell is two-pane and deep-links Models Memory Usage", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await setupAdmin(page, `settings-shell-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Replies", exact: true })).toHaveCount(0);
  await expect(settings.getByTestId("response-streaming-toggle")).toBeHidden();
  await settings.getByTestId("advanced-settings").locator("button[aria-expanded]").click();
  const streamReplies = settings.getByTestId("response-streaming-toggle");
  await expect(streamReplies).toBeVisible();
  await expect(streamReplies).not.toBeChecked();
  await expect(settings.getByText("Stream replies", { exact: true })).toBeVisible();
  await streamReplies.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-shell-general");
  const scroller = settings.getByTestId("settings-scroll");
  await scroller.evaluate((node) => {
    node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) / 2);
  });
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  // Scrolled content clips at a visible divider with space under the subtitle.
  const headerEdge = await settings.getByTestId("settings-header").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      border: Number.parseFloat(style.borderBottomWidth),
      borderStyle: style.borderBottomStyle,
      padding: Number.parseFloat(style.paddingBottom),
    };
  });
  expect(headerEdge.border).toBeGreaterThanOrEqual(1);
  expect(headerEdge.borderStyle).toBe("solid");
  expect(headerEdge.padding).toBeGreaterThanOrEqual(16);
  await captureScreenshot(page, testInfo, "settings-shell-scrolled");
  await streamReplies.click();
  await expect(streamReplies).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo.responseStreaming")))
    .toBe("on");
  const deleteAccount = settings.getByRole("button", { name: "Delete account", exact: true });
  await deleteAccount.scrollIntoViewIfNeeded();
  await expect(deleteAccount).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-general-delete-account");

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByTestId("space-memory-documents")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory");
  await page.getByRole("button", { name: "Close memory settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});

test("built-in memory documents remain available in light and dark settings", async ({
  page,
}, testInfo) => {
  await setupAdmin(
    page,
    `memory-documents-${Date.now()}@rakazo.test`,
    "password12",
    "Memory settings",
  );
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "memory");
  const documents = settings.getByTestId("space-memory-documents");
  await expect(documents.getByText("Shared documents")).toBeVisible();
  await expect(documents.getByRole("button", { name: /MEMORY\.md/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-documents-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(documents).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-documents-dark");
});
