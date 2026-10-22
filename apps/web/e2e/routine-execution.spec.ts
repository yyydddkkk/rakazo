import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, setupAdmin } from "./helpers";

test("GitHub event triggers persist their settings", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await setupAdmin(page, `routine-triggers-${stamp}@rakazo.test`, "password12", "Trigger Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const savedRoutine = async (name: string) => {
    const saved = page.waitForResponse(
      (response) => response.url().includes("/rpc/routines/create") && response.ok(),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await saved;
    const routines = await rpc<Routine[]>(page, "routines/list", { botId });
    return routines.find((routine) => routine.name === name);
  };

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  const panel = page.getByTestId("side-panel");
  await page.getByPlaceholder("Name this routine").fill("Review repository events");
  await page
    .getByPlaceholder("What should this routine do each time it runs?")
    .fill("Inspect the signed GitHub event");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Git event", exact: true }).click();

  await expect(panel.getByText("Git event", { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`/api/v1/bots/${botId}/github$`))).toBeVisible();
  await expect(page.getByText("X-Hub-Signature-256: sha256=…", { exact: true })).toBeVisible();

  expect(await savedRoutine("Review repository events")).toMatchObject({
    crons: [],
    webhookEnabled: false,
    githubEnabled: true,
  });
  await captureScreenshot(page, testInfo, "routine-github-event");
});

test("Chinese webhook routine shows its delivery fields", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Chinese Routine ${stamp}`;
  await setupAdmin(page, `routine-zh-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await page.getByRole("button", { name: "关闭用户设置" }).click();

  await page.getByRole("button", { name: "Agent 电脑", exact: true }).click();
  await page.getByRole("button", { name: "创建例行任务" }).click();
  await page.getByPlaceholder("给这个例行任务命名").fill("中文 Webhook 检查");
  await page.getByPlaceholder("每次运行时，这个例行任务应做什么？").fill("检查 Webhook。");
  await page.getByRole("button", { name: "添加触发器" }).click();
  await page.getByRole("menuitem", { name: "Webhook", exact: true }).click();

  await expect(page.getByText("当 Webhook 触发时", { exact: true })).toBeVisible();
  await expect(page.getByText("POST 到")).toBeVisible();
  await expect(page.getByText("密钥", { exact: true })).toBeVisible();
  await expect(page.getByText("请求头")).toBeVisible();
  await captureScreenshot(page, testInfo, "routine-webhook-zh");
});

test("routine test-run completes and survives reload", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await setupAdmin(page, `routine-${stamp}@rakazo.test`, "password12", "Routine");
  await completeOnboarding(page);

  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Test run" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Daily verification");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write routine-run-now-ok into the durable task result");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Weekdays", exact: true }).click();
  await expect(page.getByLabel("How often")).toHaveValue("Weekdays");
  await captureScreenshot(page, testInfo, "32-routine-configured");

  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  const routine = page.getByRole("button", { name: /Daily verification/ });
  await expect(routine).toContainText("Weekdays at 9:00 AM");
  await captureScreenshot(page, testInfo, "33-routine-scheduled");

  await routine.click();
  await page.getByRole("button", { name: "Test run" }).click();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "34-routine-run-completed");

  await page.reload();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await expect(page.getByRole("button", { name: /Daily verification/ })).toContainText(
    "Weekdays at 9:00 AM",
  );
  await page.getByRole("button", { name: /Daily verification/ }).click();
  const history = page.getByTestId("routine-run-history");
  await expect(history.getByTestId("routine-run-row")).toHaveCount(1);
  await expect(history.getByText("Done", { exact: true })).toBeVisible();
  await expect(history.getByText("No runs yet")).toHaveCount(0);
  await expect(history.getByRole("link", { name: "View chat" })).toBeVisible();
  await expect(history.getByRole("button", { name: "Run history" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await history.getByRole("button", { name: "Run history" }).click();
  await expect(history.getByRole("button", { name: "Run history" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(history.getByTestId("routine-run-row")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "36-routine-run-history");
  await history.getByRole("link", { name: "View chat" }).click();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "35-routine-run-persisted");
});

test("an unchanged routine completes without adding a chat reply", async ({ page }, testInfo) => {
  await setupAdmin(page, `routine-silent-${Date.now()}@rakazo.test`, "password12", "Quiet Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Quiet release check",
    prompt: "silent routine fixture",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: true,
  });
  const { runId } = await rpc<{ runId: string }>(page, "routines/testRun", {
    routineId: routine.id,
  });
  await expect
    .poll(async () => {
      const history = await rpc<{ runs: Array<{ id: string; status: string }> }>(
        page,
        "routines/history",
        { routineId: routine.id },
      );
      return history.runs.find((run) => run.id === runId)?.status;
    })
    .toBe("completed");
  const snapshot = await rpc<{
    messages: Array<{ runId: string | null; blocks: Array<{ kind: string }> }>;
  }>(page, "threads/get", { botId });
  expect(
    snapshot.messages
      .filter((message) => message.runId === runId)
      .flatMap((message) => message.blocks)
      .filter((block) => block.kind !== "steps"),
  ).toEqual([]);
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("NO_RESPONSE", { exact: false })).toHaveCount(0);
  await expect(transcript.getByText("Checking for changes.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await page.getByRole("button", { name: /Quiet release check/ }).click();
  await expect(
    page.getByTestId("routine-run-history").getByText("Done", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "routine-unchanged-silent");
});
