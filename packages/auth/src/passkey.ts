import { isIP } from "node:net";

export interface PasskeyRelyingParty {
  rpID: string;
  /** Exact WebAuthn client origins. */
  origins: string[];
}

/**
 * The deployment's WebAuthn relying party, derived from its web origin so a
 * self-hosted domain works without extra configuration. Returns null where a
 * browser cannot create passkeys at all: IP addresses and plain-HTTP hosts
 * other than localhost.
 */
export function passkeyRelyingParty(webOrigin: string): PasskeyRelyingParty | null {
  let url: URL;
  try {
    url = new URL(webOrigin);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (loopback) {
    // WebAuthn rejects IP relying parties, so loopback deployments use the localhost twin.
    const local = new URL(url.origin);
    local.hostname = "localhost";
    return { rpID: "localhost", origins: [local.origin] };
  }
  if (isIP(host) || url.protocol !== "https:") return null;
  return {
    rpID: host,
    origins: [url.origin],
  };
}
