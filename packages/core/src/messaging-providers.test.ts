import { describe, expect, it } from "vitest";
import { messagingProviderName } from "./messaging-providers.js";

describe("messaging provider names", () => {
  it("names known providers and falls back to the raw id", () => {
    expect(messagingProviderName("lark")).toBe("Feishu");
    expect(messagingProviderName("teams")).toBe("teams");
  });
});
