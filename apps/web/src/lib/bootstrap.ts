import type { AppBootstrap } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, attachmentMaxBytes } from "@rakazo/contracts";
import { displayIdentityResult } from "@rakazo/core";
import { initialBootstrapTarget } from "./bootstrap-target";
import { identityLabels } from "./identity-display";
import { markOnce } from "./performance";
import { rpc } from "./rpc";

let ticketBoardEnabled = false;
let maxUploadSizeBytes = ATTACHMENT_MAX_BYTES;
export function getMaxUploadSizeBytes() {
  return maxUploadSizeBytes;
}
const capabilityListeners = new Set<() => void>();
export function getTicketBoardEnabled() {
  return ticketBoardEnabled;
}
export function subscribeTicketBoardEnabled(listener: () => void) {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}

let primedBootstrap: {
  botId?: string;
  promise: Promise<AppBootstrap>;
} | null = null;

const initialTarget = initialBootstrapTarget(window.location.pathname);
if (initialTarget) {
  const { botId } = initialTarget;
  const promise = requestBootstrap(botId);
  // Authentication can redirect before Shell consumes this speculative request.
  // Register a rejection handler immediately while preserving rejection for a consumer.
  void promise.catch(() => undefined);
  primedBootstrap = { botId, promise };
}

export function takeInitialBootstrap(botId?: string) {
  const primed = primedBootstrap;
  primedBootstrap = null;
  if (primed && primed.botId === botId) {
    return primed.promise.then(
      (value) => displayIdentityResult(["bootstrap"], value, identityLabels()) as AppBootstrap,
    );
  }
  return requestBootstrap(botId);
}

function requestBootstrap(botId?: string) {
  markOnce("rk:renderer:bootstrap-request-start");
  return rpc.bootstrap(botId ? { botId } : {}).then((bootstrap) => {
    markOnce("rk:renderer:bootstrap-response");
    return applyCapabilities(bootstrap);
  });
}

function applyCapabilities(bootstrap: AppBootstrap): AppBootstrap {
  ticketBoardEnabled = bootstrap.me.ticketBoardEnabled;
  maxUploadSizeBytes = attachmentMaxBytes(bootstrap.me);
  for (const listener of capabilityListeners) listener();
  return bootstrap;
}
