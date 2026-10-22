import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { SecretMigrationRepository, SecretMigrationRow } from "./secret-migration.js";
import { upgradeLegacySecrets } from "./secret-migration.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "migration",
  traceId: "migration",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
function legacyCiphertext(encryptionKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(encryptionKey).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

describe("legacy credential upgrade", () => {
  it("rewrites pre-v2 ciphertext as v2 bound to the record id, once", async () => {
    const encrypted = new EncryptedSecretStore("key");
    const current = await encrypted.put("already v2", context, { recordId: "new" });
    const rows: SecretMigrationRow[] = [
      {
        id: "old",
        recordId: "legacy-record",
        label: "secret",
        ref: legacyCiphertext("key", "legacy value"),
      },
      { id: "new", recordId: "new", label: "secret", ref: current.ref },
      { id: "broken", recordId: "broken", label: "secret", ref: legacyCiphertext("other", "x") },
    ];
    const repository: SecretMigrationRepository = {
      async *rows() {
        for (const row of rows) yield { ...row };
      },
      replace: async (row, ref) => {
        const match = rows.find((entry) => entry.id === row.id && entry.ref === row.ref);
        if (match) match.ref = ref;
        return Boolean(match);
      },
      referenced: async () => true,
    };
    const upgrade = (dryRun?: boolean) =>
      upgradeLegacySecrets(repository, encrypted, context, { dryRun });
    expect(await upgrade(true)).toMatchObject({ planned: 1, failed: 1 });
    expect(rows[0]!.ref.startsWith("v2:")).toBe(false);
    expect(await upgrade()).toMatchObject({ migrated: 1, verified: 1, failed: 1 });
    expect(rows[0]!.ref.startsWith("v2:")).toBe(true);
    expect(await encrypted.load(rows[0]!.ref, "legacy-record")).toBe("legacy value");
    await expect(encrypted.load(rows[0]!.ref, "old")).rejects.toThrow();
    expect(rows[2]!.ref.startsWith("v2:")).toBe(false);
    expect(await upgrade()).toMatchObject({ migrated: 0, verified: 2, failed: 1 });
  });
});
