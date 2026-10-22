import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${webPort}`;
// GitHub Actions shards the suite; each shard writes a blob that the merge job turns into one report.
const reporters = [
  ...(process.env.CI ? ([["github"]] as const) : []),
  ["list"] as const,
  process.env.GITHUB_ACTIONS
    ? (["blob", { outputDir: "../../blob-report" }] as const)
    : (["html", { open: "never", outputFolder: "../../playwright-report" }] as const),
];

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  // Every scenario resets the same singleton database through private fixture setup.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: reporters,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
