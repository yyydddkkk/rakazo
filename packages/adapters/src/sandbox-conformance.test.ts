import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { fakeBoatProvider as fakeBoat } from "./boat-sandbox.test-support.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { assertSandboxWorkspaceContract, provisionPrepared } from "./sandbox-test-support.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

async function drain(provider: SandboxProvider, computer: ComputerRef) {
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["echo", "graphical-ok"] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") expect(event.code).toBe(0);
  }
  return stdout;
}

describe("sandbox conformance", () => {
  it("runs the same graphical command across fake and Boat", async () => {
    const fake = new FakeSandboxProvider();
    const boat = fakeBoat();
    const a = await provisionPrepared(fake, { botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const b = await provisionPrepared(boat, { botId: "bot-b", homePath: "/tmp/b" }, ctx);
    expect(await drain(fake, a)).toContain("graphical-ok");
    expect(await drain(boat, b)).toContain("graphical-ok");
    expect(new Set([a.id, b.id]).size).toBe(2);
    await fake.destroy(a, ctx);
    await boat.destroy(b, ctx);
  });

  it("offers the same observation, action, and workspace contract across providers", async () => {
    const providers: SandboxProvider[] = [new FakeSandboxProvider(), fakeBoat()];
    for (const [index, provider] of providers.entries()) {
      const computer = await provisionPrepared(
        provider,
        { botId: `portable-${index}`, homePath: `/tmp/portable-${index}` },
        ctx,
      );
      await assertSandboxWorkspaceContract(provider, computer, ctx);
      await provider.destroy(computer, ctx);
    }
  });

  it("explicit unsets win over inherited and request variables across providers", async () => {
    const providers: SandboxProvider[] = [new FakeSandboxProvider(), fakeBoat()];
    vi.stubEnv("RAKAZO_COMMAND_UNSET_TEST", "fake-host-value");
    try {
      for (const [index, provider] of providers.entries()) {
        const computer = await provider.provision(
          { botId: `unset-${index}`, homePath: "/unused" },
          ctx,
        );
        const events = [];
        for await (const event of provider.execute(
          computer,
          {
            argv: ["printenv", "RAKAZO_COMMAND_UNSET_TEST"],
            env: { RAKAZO_COMMAND_UNSET_TEST: "fake-request-value" },
            unsetEnv: ["RAKAZO_COMMAND_UNSET_TEST"],
          },
          ctx,
        ))
          events.push(event);
        expect(events).toEqual([{ type: "exit", code: 1 }]);
        await provider.destroy(computer, ctx);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats a repeated destroy as success so a stale deletion retry is safe", async () => {
    const providers: SandboxProvider[] = [new FakeSandboxProvider(), fakeBoat()];
    for (const [index, provider] of providers.entries()) {
      const computer = await provisionPrepared(
        provider,
        { botId: `destroy-twice-${index}`, homePath: `/tmp/destroy-twice-${index}` },
        ctx,
      );
      await provider.destroy(computer, ctx);
      await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    }
  });
});
