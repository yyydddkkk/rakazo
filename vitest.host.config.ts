import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config";

// Tests that need the real host: its process table, Docker, or desktop tooling.
// `pnpm test` leaves them out; CI runs this group in its own step.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "{apps,packages}/*/src/**/*.{host,docker}.test.ts",
      "infra/**/src/**/*.{host,docker}.test.ts",
    ],
    exclude: [...configDefaults.exclude],
  },
});
