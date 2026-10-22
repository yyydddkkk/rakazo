import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";

export interface SecretMigrationRow {
  id: string;
  label: string;
  ref: string;
  recordId: string;
  ephemeral?: boolean;
}
export interface SecretMigrationRepository {
  rows(): AsyncIterable<SecretMigrationRow>;
  /** Compare both id and original ref; a concurrent replacement always wins. */
  replace(row: SecretMigrationRow, ref: string): Promise<boolean>;
  referenced(ref: string): Promise<boolean>;
}
export interface SecretMigrationOptions {
  dryRun?: boolean;
  report?: (
    row: Pick<SecretMigrationRow, "id" | "label">,
    status: "verified" | "planned" | "migrated" | "concurrent" | "failed",
  ) => void;
}

/**
 * Rewrites credentials still in the pre-v2 format (SHA-256 key, no AAD) as v2
 * ciphertext bound to the same record id that reads use. Compare-and-set per
 * row; a concurrent replacement wins and is reported as such. Rerun-safe.
 */
export async function upgradeLegacySecrets(
  repository: SecretMigrationRepository,
  encrypted: SecretStore,
  context: AdapterContext,
  options: Pick<SecretMigrationOptions, "dryRun" | "report"> = {},
) {
  const counts = { migrated: 0, verified: 0, planned: 0, concurrent: 0, failed: 0 };
  for await (const row of repository.rows()) {
    if (context.signal.aborted) break;
    if (row.ref.startsWith("v2:")) {
      counts.verified++;
      continue;
    }
    try {
      const plaintext = await encrypted.load(row.ref, {
        recordId: row.recordId,
        signal: context.signal,
      });
      if (options.dryRun) {
        counts.planned++;
        options.report?.(row, "planned");
        continue;
      }
      const record = await encrypted.put(plaintext, context, { recordId: row.recordId });
      const check = await encrypted.load(record.ref, {
        recordId: row.recordId,
        signal: context.signal,
      });
      if (check !== plaintext) throw new Error("Upgraded credential did not round-trip");
      const status = (await repository.replace(row, record.ref)) ? "migrated" : "concurrent";
      counts[status]++;
      options.report?.(row, status);
    } catch {
      counts.failed++;
      options.report?.(row, "failed");
    }
  }
  return counts;
}
