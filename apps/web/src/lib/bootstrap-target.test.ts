import { describe, expect, it } from "vitest";
import { initialBootstrapTarget } from "./bootstrap-target";

describe("initial bootstrap target", () => {
  it("does not prime the root before routing", () => {
    expect(initialBootstrapTarget("/")).toBeNull();
  });

  it("primes browser app routes and decodes their selected bot", () => {
    expect(initialBootstrapTarget("/app/board")).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/app")).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/app/research%20bot")).toEqual({
      botId: "research bot",
    });
    expect(initialBootstrapTarget("/app/g/group-1")).toEqual({ botId: undefined });
  });

  it("does not prime unrelated routes", () => {
    expect(initialBootstrapTarget("/sign-in")).toBeNull();
    expect(initialBootstrapTarget("/onboarding")).toBeNull();
  });
});
