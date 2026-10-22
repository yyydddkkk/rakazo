import { describe, expect, it } from "vitest";

describe("messaging link codes", () => {
  it("normalizes exactly-one-code messages and rejects everything else", async () => {
    const { normalizeMessagingLinkCode } = await import("./messaging.js");
    expect(normalizeMessagingLinkCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeMessagingLinkCode("  ABCD 2345 ")).toBe("ABCD2345");
    expect(normalizeMessagingLinkCode("hello there")).toBeNull();
    expect(normalizeMessagingLinkCode("ABCD2345 please")).toBeNull();
    expect(normalizeMessagingLinkCode("ABCD234")).toBeNull();
    expect(normalizeMessagingLinkCode("")).toBeNull();
  });

  it("formats codes for humans and round-trips through normalization", async () => {
    const { formatMessagingLinkCode, normalizeMessagingLinkCode } = await import("./messaging.js");
    expect(formatMessagingLinkCode("ABCD2345")).toBe("ABCD-2345");
    expect(normalizeMessagingLinkCode(formatMessagingLinkCode("ABCD2345"))).toBe("ABCD2345");
  });
});
