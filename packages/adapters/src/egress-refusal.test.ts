import { describe, expect, it } from "vitest";
import { assertSafeRemoteUrl, createSafeLookup } from "./remote-mcp.js";
import { assertSafeWebUrl } from "./web-ssrf.js";

describe("egress refusals", () => {
  it("rejects a web fetch that resolves to a private address", async () => {
    const resolve = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(assertSafeWebUrl("https://intranet.example.test/", resolve)).rejects.toThrow(
      "URL resolves to a private address",
    );
  });

  it("rejects a connector URL aimed at the cloud metadata endpoint", async () => {
    await expect(assertSafeRemoteUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
      "Connector URL targets a private host",
    );
  });

  it("rejects a connect-time DNS answer that rebinds to a private address", async () => {
    const lookup = createSafeLookup(async () => [{ address: "192.168.1.20", family: 4 }]);
    const result = await new Promise<{ error: Error | null; address: string }>((resolve) =>
      lookup("rebind.example.test", {}, (error, address) =>
        resolve({ error, address: String(address) }),
      ),
    );
    expect(result.error?.message).toBe("Connector URL resolves to a private address");
    expect(result.address).toBe("");
  });

  it("allows a public destination", async () => {
    const resolve = async () => [{ address: "93.184.215.14", family: 4 }];
    await expect(assertSafeWebUrl("https://public.example.test/", resolve)).resolves.toEqual(
      new URL("https://public.example.test/"),
    );
  });
});
