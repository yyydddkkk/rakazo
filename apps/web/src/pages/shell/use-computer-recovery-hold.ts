import type { Me } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { computersAreUnavailable } from "../../components/ComputersUnavailableHint";
import type { Panel } from "../../lib/right-panel-state";

export function useComputerRecoveryHold(
  sandboxProvider: Me["sandboxProvider"] | undefined,
  panel: Panel,
) {
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputerRecoveryHint = computersAreUnavailable(sandboxProvider) || keepComputerRecovery;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);
  useEffect(() => {
    if (panel !== "computer") releaseComputerRecovery();
  }, [panel, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);
  return { showComputerRecoveryHint, holdComputerRecovery, releaseComputerRecovery };
}
