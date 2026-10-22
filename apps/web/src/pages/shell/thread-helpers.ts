import type { Bot, ComputerStatus, Group, ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { anySignal } from "@rakazo/core";
import type { MutableRefObject } from "react";
import {
  isComputerStatusEvent,
  isThreadSnapshotEvent,
  reduceComputerStatus,
  reduceThreadSnapshot,
} from "../../lib/thread-events";

const THREAD_SNAPSHOT_TIMEOUT_MS = 2_000;

export function threadSnapshotSignal(parent: AbortSignal): AbortSignal {
  return anySignal([parent, AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS)]);
}

export function firstThreadRoute(
  bots: readonly Pick<Bot, "id">[],
  groups: readonly Pick<Group, "id">[],
): string {
  if (bots[0]) return `/app/${bots[0].id}`;
  if (groups[0]) return `/app/g/${groups[0].id}`;
  return "/app";
}

export function applyThreadEvent(
  event: ProductEvent,
  commitSnapshot: (next: ThreadSnapshot | null) => void,
  commitComputer: (next: ComputerStatus | null) => void,
  snapshotRef: MutableRefObject<ThreadSnapshot | null>,
  computerRef: MutableRefObject<ComputerStatus | null>,
) {
  if (isThreadSnapshotEvent(event)) {
    const next = reduceThreadSnapshot(snapshotRef.current, event);
    commitSnapshot(next);
  }
  if (isComputerStatusEvent(event)) {
    const next = reduceComputerStatus(computerRef.current, event);
    commitComputer(next);
  }
}
