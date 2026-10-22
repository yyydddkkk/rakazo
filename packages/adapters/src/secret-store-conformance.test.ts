import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";

const secretTestContext: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
function conformance(name: string, create: () => SecretStore) {
  describe(`${name} SecretStore conformance`, () => {
    it("has async reads, opaque unique refs, row binding, and idempotent deletion", async () => {
      const store = create();
      await store.start();
      try {
        const first = await store.put("fake-secret", secretTestContext, { recordId: "row" });
        const second = await store.put("replacement", secretTestContext, { recordId: "row" });
        expect(first.ref).not.toContain("fake-secret");
        expect(second.ref).not.toBe(first.ref);
        expect(first.ciphertext).toBe(first.ref);
        await expect(store.load(first.ref, "row")).resolves.toBe("fake-secret");
        await expect(store.load(second.ref, "row")).resolves.toBe("replacement");
        await expect(store.load(first.ref, "other-row")).rejects.toThrow();
        await store.delete(first.ref, "row");
        await store.delete(first.ref, "row");
        expect(store.redact("sk-fake-secret-value")).not.toContain("sk-fake-secret-value");
      } finally {
        await store.close();
      }
    });
    it("notifies by ref and unsubscribes", async () => {
      const store = create();
      await store.start();
      const listener = vi.fn();
      const unsubscribe = store.onChange(listener);
      const record = await store.put("fake", secretTestContext);
      expect(listener).toHaveBeenCalledWith(record.ref);
      await store.delete(record.ref, record.id);
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      await store.delete(record.ref, record.id);
      expect(listener).toHaveBeenCalledTimes(2);
      await store.close();
    });
    it("honors caller cancellation", async () => {
      const store = create();
      await store.start();
      const record = await store.put("fake", secretTestContext);
      await expect(
        store.load(record.ref, { recordId: record.id, signal: AbortSignal.abort() }),
      ).rejects.toThrow();
      await store.close();
    });
  });
}
conformance("encrypted", () => new EncryptedSecretStore("test-key"));
