import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, setupAdmin } from "./helpers";

test("the top-left switcher shows one space at a time", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await setupAdmin(page, `space-switcher-${stamp}@rakazo.test`, "password12", "Switcher");
  await completeOnboarding(page);
  await rpc(page, "spaces/create", { name: "Support" });
  await page.reload();

  const sidebar = page.getByTestId("bots-sidebar");
  const switcher = page.getByTestId("space-switcher");
  await expect(sidebar.getByText("Chief").first()).toBeVisible();

  await switcher.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await expect(page.getByRole("menuitem", { name: "New space" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete space" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "space-switcher-menu");
  await page.getByRole("menuitemradio", { name: "Support" }).click();

  // The other space is empty and its bots never appear in this one's sidebar.
  await expect(switcher).toContainText("Support");
  await expect(sidebar.getByText("Chief")).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);

  await switcher.click();
  await expect(page.getByRole("menuitem", { name: "Delete space" })).toBeVisible();
  await captureScreenshot(page, testInfo, "space-switcher-other-space");
});
