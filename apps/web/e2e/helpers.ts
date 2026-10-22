import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { resetAdminFixture } from "../../../packages/testkit/src/fixture-account";

export function activeBotId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id || id === "app") throw new Error(`missing bot id in ${page.url()}`);
  return id;
}

export async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

export async function completeOnboarding(page: Page, testInfo?: TestInfo) {
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(page.getByText("Chief").first()).toBeVisible();
  if (testInfo) {
    await captureScreenshot(page, testInfo, "03-create-first-bot");
    await captureScreenshot(page, testInfo, "06-onboarding-complete");
  }
}

/** Private DB bootstrap followed by the production password sign-in flow. */
export async function setupAdmin(
  page: Page,
  email: string,
  password: string,
  name: string,
  testInfo?: TestInfo,
) {
  await resetAdminFixture(email, password, name);
  if (testInfo) {
    await signInThroughForm(page, email, password, testInfo);
    return;
  }
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("Admin sign-in needs a baseURL");
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin: new URL(baseURL).origin },
  });
  if (!response.ok()) throw new Error(`sign-in ${response.status()}: ${await response.text()}`);
  await page.goto("/onboarding");
}

export async function setupAdminThroughForm(
  page: Page,
  email: string,
  password: string,
  name: string,
  testInfo?: TestInfo,
) {
  await resetAdminFixture(email, password, name);
  await signInThroughForm(page, email, password, testInfo);
}

async function signInThroughForm(page: Page, email: string, password: string, testInfo?: TestInfo) {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  if (testInfo) await captureScreenshot(page, testInfo, "01-sign-in");
  await page.getByRole("button", { name: "Continue with email" }).click();
}

export async function showPasswordForm(page: Page) {
  await expect(page.getByPlaceholder("Password")).toBeVisible();
}

/** Open Advanced through its trigger, preserving an already-expanded section. */
export async function expandAdvancedSection(section: Locator) {
  const trigger = section.getByRole("button", { name: "Advanced", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await waitForTransitions(section);
}

/** Waits for fold-outs to settle before clicking or dragging their contents. */
async function waitForTransitions(element: Locator) {
  // Base UI starts a fold a frame after the toggle.
  await element.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  await expect
    .poll(() =>
      element.evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation instanceof CSSTransition).length,
      ),
    )
    .toBe(0);
}

export async function waitForSidebarTransitions(page: Page) {
  await waitForTransitions(page.locator("aside").first());
}

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

export async function openNewBot(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-bot").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create");
  await expect(page.getByTestId("create-bot-form")).toBeVisible();
}

export async function openNewGroup(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-group").click();
}

/** Open the create form from the + picker, submit, and wait for the new chat. */
export async function createBotFromPicker(
  page: Page,
  options: {
    name?: string;
    title?: string;
    description?: string;
    computerMode?: "team" | "dedicated";
  } = {},
) {
  const name = options.name ?? "New Bot";
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill(name);
  if (options.title != null) {
    await form.locator("label:has-text('Title') input").fill(options.title);
  }
  if (options.description != null) {
    await form.locator("label:has-text('Description') textarea").fill(options.description);
  }
  if (options.computerMode === "dedicated") {
    await form.getByTestId("create-bot-private").click();
  } else if (options.computerMode === "team") {
    await form.getByTestId("create-bot-team").click();
  }
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
}

/** Open the user Settings overlay, optionally switching to a sidebar section. */
export async function openUserSettings(
  page: Page,
  section?: "general" | "models" | "memory" | "usage" | "computer" | "updates",
) {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  if (section && section !== "general") {
    await settings.getByTestId(`settings-nav-${section}`).click();
  }
  return settings;
}

/** Create a named bot via RPC for test setup (skips the + picker). */
export async function createNamedBot(
  page: Page,
  name: string,
  options: { computerMode?: "team" | "dedicated" } = {},
) {
  const bot = await rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: options.computerMode ?? "team",
  });
  await page.goto(`/app/${bot.id}`);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  return bot.id;
}

/**
 * Picks an option from one of the kit's dropdowns. They open a menu of options rather than a
 * native select, so selectOption() does not apply; options are matched by their visible name.
 */
export async function chooseOption(trigger: Locator, option: string | { index: number }) {
  await trigger.click();
  const options = trigger.page().getByRole("option");
  await (typeof option === "string"
    ? trigger.page().getByRole("option", { name: option, exact: true })
    : options.nth(option.index)
  ).click();
}
