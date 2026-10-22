import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@lingui\/core\/macro$/,
        replacement: fileURLToPath(
          new URL("./packages/testkit/src/lingui-core-macro.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    setupFiles: ["./packages/testkit/src/pin-test-env.ts"],
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "infra/sandboxes/supervisor/src/**/*.test.ts",
      "infra/compose/tests/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
      "apps/api/src/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
    ],
    // Host-dependent tests (real process table, Docker, desktop tooling) run through
    // `pnpm test:host` (vitest.host.config.ts), which CI also runs.
    exclude: [...configDefaults.exclude, "**/*.host.test.ts", "**/*.docker.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
