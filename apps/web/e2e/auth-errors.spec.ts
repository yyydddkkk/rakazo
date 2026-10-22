import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("sign-in shows translated credential errors", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: { passwordReset: false, resetUrl: null },
    }),
  );
  await page.route("**/api/auth/sign-in/email", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "INVALID_EMAIL_OR_PASSWORD", message: "INVALID_EMAIL_OR_PASSWORD" },
    }),
  );

  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("user@example.test");
  await page.getByLabel("Password", { exact: true }).fill("password12");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(
    page.getByRole("alert").getByText("Invalid email or password", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-invalid-credentials");
});
