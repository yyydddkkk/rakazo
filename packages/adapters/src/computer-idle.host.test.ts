import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_WORK_LAUNCH,
  BACKGROUND_WORK_PROBE,
  CANCEL_COMPUTER_RUN_WORK,
} from "./computer-idle.js";

// The probe walks /proc/*/fd on whatever machine runs it, so this runs in the host group
// (pnpm test:host); a desktop with many open files takes far longer than the container it targets.
describe("background work launch and probe", () => {
  const children: ReturnType<typeof spawn>[] = [];
  const markers = new Set<string>();

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    for (const marker of markers) {
      rmSync(marker, { force: true, recursive: true });
    }
    markers.clear();
  });

  it.skipIf(process.platform === "win32")(
    "detects active work only when launch and probe share the same marker id",
    async () => {
      const databaseId = "computer-db-id";
      const providerRef = "provider-ref";
      const launchId = "active";
      markers.add(`/tmp/rakazo-background-${databaseId}-run-1-${launchId}`);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          databaseId,
          "run-1",
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(databaseId)).toBe(0);
      // ComputerRef.id is providerRef today; probing that path must not see the DB-id marker.
      expect(await probeBackgroundWork(providerRef)).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans a completed marker without blocking a later launch",
    async () => {
      const markerId = "computer-relaunch-id";
      const completedMarker = `/tmp/rakazo-background-${markerId}-run-1-completed`;
      const activeMarker = `/tmp/rakazo-background-${markerId}-run-1-active`;
      markers.add(completedMarker);
      markers.add(activeMarker);
      const completed = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "completed",
          "true",
        ],
        { stdio: "ignore" },
      );
      children.push(completed);

      expect(await processExit(completed)).toBe(0);
      expect(await probeBackgroundWork(markerId)).toBe(1);
      expect(existsSync(completedMarker)).toBe(false);

      const active = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "active",
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(active);
      await expect.poll(() => probeBackgroundWork(markerId)).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not run the command when its marker cannot be opened",
    async () => {
      const markerId = "computer-marker-error";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      mkdirSync(marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a pre-existing marker symlink",
    async () => {
      const markerId = "computer-marker-symlink";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      symlinkSync(commandRan, marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cancel tears down background shell work for that run",
    async () => {
      const computerId = "computer-cancel-id";
      const runId = "run-cancel-1";
      const launchId = "active";
      const marker = `/tmp/rakazo-background-${computerId}-${runId}-${launchId}`;
      markers.add(marker);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          computerId,
          runId,
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(computerId)).toBe(0);

      const launchedDone = processExit(launched);
      const cancel = spawn(
        "bash",
        ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId],
        { stdio: "ignore" },
      );
      children.push(cancel);
      expect(await processExit(cancel)).toBe(0);
      await launchedDone;
      expect(await probeBackgroundWork(computerId)).toBe(1);
    },
  );
});

function probeBackgroundWork(markerId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", markerId],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function processExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
