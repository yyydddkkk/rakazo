import { describe, expect, it } from "vitest";
import {
  classifySandboxProvider,
  computersAreUnavailable,
  sandboxCheckFailureMessage,
  sandboxEnvGuidanceLines,
  sandboxEnvGuidanceText,
} from "./computer-sandbox.js";

describe("computersAreUnavailable", () => {
  it("treats none and empty as unavailable", () => {
    expect(computersAreUnavailable("none")).toBe(true);
    expect(computersAreUnavailable("")).toBe(true);
    expect(computersAreUnavailable(null)).toBe(false);
  });

  it("treats configured providers as available", () => {
    expect(computersAreUnavailable("docker")).toBe(false);
    expect(computersAreUnavailable("fake")).toBe(false);
  });
});

describe("classifySandboxProvider", () => {
  it("classifies Docker and unavailable states", () => {
    expect(classifySandboxProvider("none")).toBe("none");
    expect(classifySandboxProvider(null)).toBe("none");
    expect(classifySandboxProvider("docker")).toBe("docker");
  });
});

describe("sandboxEnvGuidanceText", () => {
  it("uses placeholder tokens and activates only one provider", () => {
    const text = sandboxEnvGuidanceText();
    expect(text).toContain("SANDBOX_SUPERVISOR_TOKEN=<generate-a-secret>");
    expect(text).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(sandboxEnvGuidanceLines().filter((line) => /^SANDBOX_PROVIDER=/.test(line))).toEqual([
      "SANDBOX_PROVIDER=docker",
    ]);
  });
});

describe("sandboxCheckFailureMessage", () => {
  it("returns error message or fallback", () => {
    expect(sandboxCheckFailureMessage(new Error("offline"))).toBe("offline");
    expect(sandboxCheckFailureMessage(null)).toBe("Could not reach the server");
  });
});
