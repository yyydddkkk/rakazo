import { expect, it } from "vitest";
import { createAgentRuntimeSelection } from "./agent-runtime-selection.js";

it("defaults to Pi and shares selected instances across API/worker composition", () => {
  const selection = createAgentRuntimeSelection({ dataDir: "data" });
  expect(selection.runtime.describe().id).toBe("pi");
  expect(selection.runtimeFor(null)).toBe(selection.runtime);
  expect(selection.runtimeFor("pi")).toBe(selection.runtime);
  expect(selection.runtimeFor("omp").describe().id).toBe("omp");
  expect(selection.runtimeFor("omp")).toBe(selection.runtimeFor("omp"));
});

it("supports deployment omp and scripted defaults with explicit Pi overrides", () => {
  for (const defaultRuntime of ["omp", "scripted"]) {
    const selection = createAgentRuntimeSelection({ dataDir: "data", defaultRuntime });
    expect(selection.runtime.describe().id).toBe(defaultRuntime);
    expect(selection.runtimeFor(undefined)).toBe(selection.runtime);
    expect(selection.runtimeFor("pi").describe().id).toBe("pi");
  }
  expect(() => createAgentRuntimeSelection({ dataDir: "data", defaultRuntime: "unknown" })).toThrow(
    "Unsupported agent runtime",
  );
});
