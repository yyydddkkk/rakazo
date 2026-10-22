import type { SandboxProviderOptions } from "./sandbox-factory.js";

/** Keep Docker disabled when production credentials are unavailable. */
export function resolveSandboxProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.SANDBOX_PROVIDER;
  if (configured !== undefined && !configured.trim()) return "none";
  const requested = configured?.trim() || "docker";
  // Production without a supervisor token cannot run Docker computers; boot as none instead of exiting.
  if (
    requested === "docker" &&
    source.NODE_ENV === "production" &&
    !optional(source.SANDBOX_SUPERVISOR_TOKEN)
  ) {
    return "none";
  }
  return requested;
}

export function sandboxProviderOptionsFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): SandboxProviderOptions {
  return {
    supervisorUrl: optional(source.SANDBOX_SUPERVISOR_URL),
    supervisorToken: optional(source.SANDBOX_SUPERVISOR_TOKEN),
  };
}

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
