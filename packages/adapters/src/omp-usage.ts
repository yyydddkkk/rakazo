import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
const MAX_ENTRY_BYTES = 65_536;

export interface OmpUsageScope {
  runId: string;
  botId: string;
  threadId: string;
  spaceId: string;
  userId: string;
}

export type OmpUsageRecovery = (event: UsageEvent, scope: OmpUsageScope) => Promise<void>;

interface UsageEntry {
  version: 1;
  scope: OmpUsageScope;
  event: UsageEvent;
}

/** A local outbox, not an omp session: only numeric usage and attribution enter it. */
export class OmpUsageJournal {
  private directory: string;
  private completed = new Set<string>();
  private inFlight = new Map<string, Promise<UsageEvent | undefined>>();
  private serial = Promise.resolve();

  constructor(
    private options: {
      root: string;
      scope?: OmpUsageScope;
      onUsage?: (event: UsageEvent) => void | Promise<void>;
      recoverUsage?: OmpUsageRecovery;
      deliveryTimeoutMs?: number;
    },
  ) {
    if (
      options.deliveryTimeoutMs !== undefined &&
      (!Number.isFinite(options.deliveryTimeoutMs) ||
        options.deliveryTimeoutMs <= 0 ||
        options.deliveryTimeoutMs > 60_000)
    )
      throw new Error("omp usage accounting timeout is invalid");
    this.directory = join(options.root, ".omp-usage");
  }

  private key(event: UsageEvent): string {
    if (!event.callId) throw new Error("omp usage requires a stable call ID");
    return createHash("sha256").update(event.callId).digest("hex");
  }

  private async syncDirectory(path = this.directory) {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async persist(entry: UsageEntry): Promise<string> {
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES)
      throw new Error("omp usage entry exceeded the size limit");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Persist creation of the outbox directory itself before acknowledging usage.
    await this.syncDirectory(this.options.root);
    const destination = join(this.directory, `${this.key(entry.event)}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(serialized);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      await this.syncDirectory();
    } finally {
      await rm(temporary, { force: true });
    }
    return destination;
  }

  private async deliver(
    entry: UsageEntry,
    destination: string,
    sink: (event: UsageEvent) => void | Promise<void>,
  ) {
    // The persistent sink must deduplicate callId: it may commit and then throw.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => sink(entry.event)),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("omp usage accounting timed out")),
                this.options.deliveryTimeoutMs ?? 5_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        await rm(destination, { force: true });
        await this.syncDirectory();
        this.completed.add(this.key(entry.event));
        return;
      } catch {
        if (attempt === 2) throw new Error("omp usage accounting failed; retained for recovery");
      }
    }
  }

  /** Call from the producer, before exposing usage to the event consumer. */
  async record(event: UsageEvent): Promise<UsageEvent | undefined> {
    const key = this.key(event);
    if (this.completed.has(key)) return undefined;
    const existing = this.inFlight.get(key);
    if (existing) {
      await existing;
      return undefined;
    }
    // Independent calls must reach disk even while another ledger callback is blocked.
    const pending = (async () => {
      if (!this.options.onUsage) {
        this.completed.add(key);
        return event;
      }
      if (!this.options.scope) throw new Error("omp usage attribution is unavailable");
      const entry: UsageEntry = {
        version: 1,
        scope: storedScope(this.options.scope),
        event: storedUsage(event),
      };
      validateEntry(entry);
      const destination = await this.persist(entry);
      await this.deliver(entry, destination, this.options.onUsage);
      return { ...entry.event, accounted: true };
    })();
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Recover original attribution; a new run's bound onUsage must never receive old runs. */
  async drain(): Promise<void> {
    const pending = this.serial.then(async () => {
      await Promise.allSettled([...this.inFlight.values()]);
      await this.recover();
    });
    this.serial = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async recover(): Promise<void> {
    const filenames = await readdir(this.directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw new Error("omp usage recovery directory is unavailable");
    });
    for (const filename of filenames.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const destination = join(this.directory, filename);
      let raw: string;
      try {
        raw = await readEntry(destination);
      } catch (error) {
        // Another run can finish recovery concurrently; the ledger handles duplicate sends.
        if (isMissing(error)) continue;
        throw new Error("omp usage recovery entry is unavailable");
      }
      const entry = parseEntry(raw);
      if (`${this.key(entry.event)}.json` !== filename)
        throw new Error("omp usage recovery entry is invalid");
      const current =
        this.options.scope &&
        Object.entries(entry.scope).every(
          ([key, value]) => this.options.scope?.[key as keyof OmpUsageScope] === value,
        );
      const sink =
        current && this.options.onUsage
          ? this.options.onUsage
          : this.options.recoverUsage
            ? (event: UsageEvent) => this.options.recoverUsage!(event, entry.scope)
            : undefined;
      if (sink) await this.deliver(entry, destination, sink);
    }
  }
}

/** Invoke during worker startup, before runs are claimed; it does not require omp. */
export async function recoverPendingOmpUsage(options: {
  root: string;
  recoverUsage: OmpUsageRecovery;
}): Promise<void> {
  await new OmpUsageJournal(options).drain();
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function storedScope(scope: OmpUsageScope): OmpUsageScope {
  const { runId, botId, threadId, spaceId, userId } = scope;
  return { runId, botId, threadId, spaceId, userId };
}

async function readEntry(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_ENTRY_BYTES) throw new Error("invalid");
    // Bound the actual read as well: a file can grow between stat and read.
    const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_ENTRY_BYTES) throw new Error("invalid");
    return buffer.toString("utf8", 0, size);
  } finally {
    await file.close();
  }
}

/** Explicit allowlist prevents accidental prompt/result/credential persistence. */
function storedUsage(event: UsageEvent): UsageEvent {
  const result: UsageEvent = {
    type: "usage",
    provider: event.provider,
    model: event.model,
    callId: event.callId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
  };
  for (const field of [
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
    "costSource",
    "pricingVersion",
    "usageSource",
    "operationKind",
    "agentId",
  ] as const) {
    const value = event[field];
    if (value !== undefined) Object.assign(result, { [field]: value });
  }
  return result;
}

function parseEntry(raw: string): UsageEntry {
  try {
    const entry = JSON.parse(raw) as UsageEntry;
    validateEntry(entry);
    return {
      version: 1,
      scope: storedScope(entry.scope),
      event: storedUsage(entry.event),
    };
  } catch {
    throw new Error("omp usage recovery entry is invalid");
  }
}

function boundedString(value: unknown, maxLength = 2_048): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validateEntry(entry: UsageEntry): void {
  try {
    if (
      entry.version !== 1 ||
      !entry.scope ||
      ![
        entry.scope.runId,
        entry.scope.botId,
        entry.scope.threadId,
        entry.scope.spaceId,
        entry.scope.userId,
      ].every((value) => boundedString(value, 512)) ||
      entry.event?.type !== "usage" ||
      !boundedString(entry.event.callId, 4_096) ||
      !boundedString(entry.event.provider) ||
      !boundedString(entry.event.model) ||
      entry.event.inputTokens === undefined ||
      entry.event.outputTokens === undefined
    )
      throw new Error("invalid");
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "cacheWrite1hTokens",
      "reasoningTokens",
      "totalTokens",
    ] as const) {
      const value = entry.event[field];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 2_147_483_647)
      )
        throw new Error("invalid");
    }
    const cost = entry.event.costUsd;
    if (
      cost !== undefined &&
      cost !== null &&
      (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    )
      throw new Error("invalid");
    for (const field of ["costSource", "pricingVersion", "usageSource", "agentId"] as const) {
      const value = entry.event[field];
      if (value !== undefined && value !== null && !boundedString(value))
        throw new Error("invalid");
    }
    const operation = entry.event.operationKind;
    if (
      operation !== undefined &&
      !["answer", "setup", "retrieval", "subagent", "compaction"].includes(operation)
    )
      throw new Error("invalid");
  } catch {
    throw new Error("omp usage entry is invalid");
  }
}
