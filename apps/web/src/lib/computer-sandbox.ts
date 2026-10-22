import { t } from "@lingui/core/macro";
import type { Me } from "@rakazo/contracts";
import { rpc } from "./rpc";
import { errorText } from "./user-error";

export function computersAreUnavailable(sandboxProvider: string | null | undefined): boolean {
  return sandboxProvider === "none" || sandboxProvider === "";
}

export type SandboxAvailabilityPhase = "idle" | "loading" | "recovered" | "unavailable" | "failure";

/** Lines to paste into `.env` — placeholders only, never real secrets. */
export function sandboxEnvGuidanceLines(): string[] {
  return [
    "SANDBOX_PROVIDER=docker",
    "SANDBOX_SUPERVISOR_TOKEN=<generate-a-secret>",
    "",
    "# Recreate the stack after changing .env",
  ];
}

export function sandboxEnvGuidanceText(): string {
  return sandboxEnvGuidanceLines().join("\n");
}

export type SandboxProviderKind = "none" | "docker" | "other";

export function classifySandboxProvider(provider: string | null | undefined): SandboxProviderKind {
  if (provider == null || provider === "" || computersAreUnavailable(provider)) return "none";
  if (provider === "docker") return "docker";
  return "other";
}

export function sandboxProviderLabel(provider: string): string {
  if (provider === "docker") return "Docker";
  if (provider === "fake") return "Fake";
  return provider;
}

export async function refreshSandboxFromServer(): Promise<Me> {
  const [health, me] = await Promise.all([rpc.health(), rpc.me()]);
  if (!health.ok) {
    throw new Error("Server health check failed");
  }
  return me;
}

export function sandboxCheckFailureMessage(error: unknown): string {
  return errorText(error, t`Could not reach the server`);
}
