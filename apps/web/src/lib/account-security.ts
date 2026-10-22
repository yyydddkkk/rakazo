import { t } from "@lingui/core/macro";
import { accountSecuritySchema, legacyAccountSecurity } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";

export async function fetchAccountSecurity() {
  const response = await fetch("/api/auth/account-security", {
    signal: AbortSignal.timeout(8_000),
  });
  // Cached clients can outlive the connected API version.
  if (response.status === 404) return legacyAccountSecurity;
  if (!response.ok) throw new Error(t`Could not load sign-in options`);
  try {
    return accountSecuritySchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024));
  } catch {
    throw new Error(t`Could not load sign-in options`);
  }
}
