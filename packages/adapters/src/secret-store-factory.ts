import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  RealtimeFanout,
  SecretContext,
  SecretPutOptions,
  SecretStore,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { SecretChanges } from "./secret-changes.js";
import { EncryptedSecretStore } from "./secrets.js";

/** Routing is private to the store; consumers only see opaque refs. */
export class ComposedSecretStore extends SecretChanges implements SecretStore {
  private readonly origin = randomUUID();
  private closed = false;
  private starting?: Promise<void>;
  private unsubscribe?: () => Promise<void>;
  private readonly subscriptions: Array<() => void> = [];
  constructor(
    private readonly encrypted: SecretStore,
    private readonly realtime?: RealtimeFanout,
  ) {
    super();
    this.subscriptions.push(encrypted.onChange((ref) => this.changed(ref)));
  }
  describe() {
    return this.encrypted.describe();
  }
  start(): Promise<void> {
    this.starting ??= this.startOnce();
    return this.starting;
  }
  private async startOnce(): Promise<void> {
    await this.encrypted.start();
    if (this.closed) return;
    if (this.realtime)
      this.unsubscribe = await this.realtime.subscribe("secret-store-change", (payload) => {
        try {
          const event = JSON.parse(payload);
          if (event.origin !== this.origin && typeof event.ref === "string") {
            this.changed(event.ref);
          }
        } catch {
          /* Ignore malformed notifications. */
        }
      });
  }
  private async publish(ref: string): Promise<void> {
    try {
      await this.realtime?.publish(
        "secret-store-change",
        JSON.stringify({ origin: this.origin, ref }),
      );
    } catch {
      getLogger().warn("Secret change notification failed");
    }
  }
  async put(value: string, context: AdapterContext, options: SecretPutOptions = {}) {
    const record = await this.encrypted.put(value, context, options);
    await this.publish(record.ref);
    return record;
  }
  load(ref: string, context: SecretContext): Promise<string> {
    return this.encrypted.load(ref, context);
  }
  async delete(ref: string, context: SecretContext): Promise<void> {
    try {
      await this.encrypted.delete(ref, context);
    } finally {
      await this.publish(ref);
    }
  }

  redact(_value: string): string {
    return "[redacted]";
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.subscriptions) stop();
    await this.starting?.catch(() => undefined);
    try {
      await this.unsubscribe?.();
    } catch {
      getLogger().warn("Secret notification shutdown failed");
    }
    this.unsubscribe = undefined;
    await this.encrypted.close();
    this.clearListeners();
  }
}

export function createSecretStore(encryptionKey: string, realtime?: RealtimeFanout): SecretStore {
  const encrypted = new EncryptedSecretStore(encryptionKey);
  return realtime ? new ComposedSecretStore(encrypted, realtime) : encrypted;
}

export async function deleteSecretBestEffort(
  store: Pick<SecretStore, "delete">,
  ref: string,
  context: SecretContext,
): Promise<void> {
  try {
    await store.delete(ref, context);
  } catch {
    getLogger().warn("Secret deletion failed; retry cleanup before removing provider access");
  }
}
