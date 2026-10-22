import { useCallback, useEffect, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";

/** Server-side facts the settings overlay and composer need: messaging availability and usage. */
export function useSettingsStatus(rpc: ReturnType<typeof createSpaceRpc>, user: unknown) {
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) {
          setMessagingSurfaceEnabled(status.enabled);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);
  const [usage, setUsage] = useState<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
    runs: number;
  } | null>(null);
  const refreshUsage = useCallback(() => {
    void rpc.usage
      .summary()
      .then(setUsage)
      .catch(() => undefined);
  }, []);
  return { messagingSurfaceEnabled, usage, refreshUsage };
}
