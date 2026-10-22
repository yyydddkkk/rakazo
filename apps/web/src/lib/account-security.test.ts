import { afterEach, expect, it, vi } from "vitest";
import { fetchAccountSecurity } from "./account-security";

afterEach(() => vi.unstubAllGlobals());
it("falls back to password account controls on an older server's 404", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Not found", { status: 404 })),
  );
  await expect(fetchAccountSecurity()).resolves.toEqual({
    hasPassword: true,
    passwordChangeEnabled: true,
  });
});
it.each([401, 500])("refuses account-security HTTP %s", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status })),
  );
  await expect(fetchAccountSecurity()).rejects.toThrow();
});
it("rejects malformed successful account-security responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ hasPassword: "true" })),
  );
  await expect(fetchAccountSecurity()).rejects.toThrow();
});

it("localizes non-JSON successful account-security responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html>Gateway error</html>")),
  );
  await expect(fetchAccountSecurity()).rejects.toThrow("Could not load sign-in options");
});
