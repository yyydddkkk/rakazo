import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, setupAdmin } from "./helpers";

test("account settings offers only English and Simplified Chinese and persists the choice", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await setupAdmin(page, `ui-locale-zh-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("option", { name: "English", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "简体中文", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-zh");

  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "账户", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "语言", exact: true })).toBeVisible();
  await expect(picker).toHaveText("简体中文");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await captureScreenshot(page, testInfo, "ui-locale-settings-zh");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeInViewport({ ratio: 1 });
  const box = await sidebar.boundingBox();
  expect(box?.x).toBeCloseTo(0, 0);
  await captureScreenshot(page, testInfo, "ui-locale-app-zh");
});
