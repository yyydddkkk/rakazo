import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, setupAdmin } from "./helpers";

async function captureSidebarSearchSelected(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const search = aside.getByTestId("sidebar-search");
  const selected = aside.getByRole("button", { name: /^Chief/ }).first();
  await expect(search).toBeVisible();
  await expect(selected).toBeVisible();
  await search.scrollIntoViewIfNeeded();

  const searchBox = await search.boundingBox();
  const selectedBox = await selected.boundingBox();
  expect(searchBox).toBeTruthy();
  expect(selectedBox).toBeTruthy();
  if (searchBox && selectedBox) {
    expect(Math.abs(searchBox.x - selectedBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(searchBox.x + searchBox.width - (selectedBox.x + selectedBox.width)),
    ).toBeLessThanOrEqual(1);
  }

  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height * 0.45, 280), 420),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("account settings appearance control switches to light mode", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await setupAdmin(page, `ui-appearance-${stamp}@rakazo.test`, "password12", "Appearance QA");
  await completeOnboarding(page, testInfo);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-appearance-select");
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-appearance-control");

  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "ui-appearance-dark-settings");

  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(settings.getByTestId("ui-appearance-light")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "ui-appearance-light-settings");

  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "ui-appearance-light-shell");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-light");

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Please review `shared/PROJECT_CHECKPOINT_WRAPUP.md`.");
  await composer.press("Enter");
  const assistantReply = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: "done. i handled:" });
  const inlinePath = assistantReply
    .locator("code")
    .filter({ hasText: "shared/PROJECT_CHECKPOINT_WRAPUP.md" });
  await expect(inlinePath).toBeVisible({ timeout: 30_000 });
  await expect(inlinePath).toHaveCSS("color", "rgb(0, 0, 0)");
  await captureScreenshot(page, testInfo, "inline-code-light");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-dark");
});

test("sidebar footer opens the account menu", async ({ page }, testInfo) => {
  await setupAdmin(page, `footer-web-${Date.now()}@rakazo.test`, "password12", "Footer Demo");
  await completeOnboarding(page);
  const footer = page.getByTestId("sidebar-footer");
  await expect(footer).toBeVisible();
  const searchBox = await page.getByTestId("sidebar-search").boundingBox();
  const avatarBox = await page.getByTestId("user-menu-trigger").boundingBox();
  expect(searchBox).toBeTruthy();
  expect(avatarBox).toBeTruthy();
  if (searchBox && avatarBox) expect(avatarBox.x).toBe(searchBox.x);
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("link", { name: "Docs", exact: true })).toBeVisible();
  if (avatarBox) {
    await expect
      .poll(async () => {
        const menuBox = await page.locator('[data-slot="popover-content"]').boundingBox();
        return (
          menuBox && {
            x: menuBox.x,
            width: menuBox.width,
            gap: avatarBox.y - menuBox.y - menuBox.height,
          }
        );
      })
      .toMatchObject({ x: avatarBox.x, gap: 8 });
  }
  await captureScreenshot(page, testInfo, "sidebar-footer-menu");
  await page.keyboard.press("Escape");
  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(footer).toBeInViewport();
  await expect(page.getByTestId("bots-sidebar")).toHaveCSS("width", "80px");
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
  await page.getByTestId("restore-bots-sidebar").click();
  await expect(footer).toBeInViewport();
});

test("sidebar footer keeps the account identity readable", async ({ page }, testInfo) => {
  const email = `footer-${Date.now()}@rakazo.test`;
  await setupAdmin(page, email, "password12", "Footer Demo");
  await completeOnboarding(page);
  await page.request.post("/api/auth/update-user", { data: { name: "Footer Demo" } });
  await page.reload();
  const footer = page.getByTestId("sidebar-footer");
  const avatar = page.getByTestId("user-menu-trigger");
  const session = await (await page.request.get("/api/auth/get-session")).json();
  await expect(avatar).toHaveAccessibleName(`Account menu for ${session.user.name}`);
  await avatar.click();
  const header = page.getByTestId("account-menu-header");
  await expect(header).toHaveText(`${session.user.name}${email}`);
  await expect(page.getByText("New update available", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-footer-menu");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(avatar).toBeInViewport();
  expect(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 740, height: 320 });
  await avatar.click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return box && box.y >= 0 && box.y + box.height <= 320;
    })
    .toBe(true);
  await expect(header).toBeInViewport();
  await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  const logOut = menu.getByRole("button", { name: "Log out", exact: true });
  await logOut.scrollIntoViewIfNeeded();
  await expect(logOut).toBeInViewport();
  expect((await logOut.boundingBox())!.height).toBe(36);
  await captureScreenshot(page, testInfo, "sidebar-footer-short-screen");
  await menu.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("user-settings")).toBeVisible();
});

test("sidebar list fades above the transparent footer and keeps the last row reachable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await setupAdmin(page, `footer-scroll-${Date.now()}@rakazo.test`, "password12", "Demo User");
  await completeOnboarding(page);
  for (let index = 0; index < 20; index++) {
    await rpc(page, "bots/create", {
      name: `Demo chat ${index}`,
      title: "",
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const footer = page.getByTestId("sidebar-footer");
  const list = sidebar.locator(".rk-scroll").first();
  const lastRow = list.getByRole("button", { name: /^Demo chat 19/ }).first();
  await expect(lastRow).toHaveCount(1);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => localStorage.setItem("rakazo.uiAppearance", theme), theme);
    await page.reload();
    await expect(lastRow).toHaveCount(1);
    await expect(footer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(footer).toHaveCSS("background-image", "none");
    await list.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) / 2));
    await expect
      .poll(() =>
        list.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-fade-b"))),
      )
      .toBeGreaterThan(20);
    const listBox = await list.boundingBox();
    const avatarBox = await page.getByTestId("user-menu-trigger").boundingBox();
    expect(listBox!.y + listBox!.height).toBeLessThan(avatarBox!.y);
    // Disabling animations fast-forwards the scroll timeline and removes its fade.
    const screenshotPath = testInfo.outputPath(`sidebar-footer-scrolled-${theme}.png`);
    await page.screenshot({ path: screenshotPath, animations: "allow" });
    await testInfo.attach(`sidebar-footer-scrolled-${theme}`, {
      contentType: "image/png",
      path: screenshotPath,
    });
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect
      .poll(() =>
        list.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-fade-b"))),
      )
      .toBe(0);
    await lastRow.focus();
    await expect(lastRow).toBeFocused();
    await expect(lastRow).toBeInViewport();
    const rowBox = await lastRow.boundingBox();
    expect(rowBox!.y + rowBox!.height).toBeLessThan(avatarBox!.y);
  }
});
