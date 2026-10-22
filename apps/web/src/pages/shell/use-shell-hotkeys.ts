import { useEffect } from "react";
import { isCommandPaletteHotkey } from "./command-palette";

export function useShellHotkeys(
  computerOpen: boolean,
  setComputerOpen: (open: boolean) => void,
  setCommandPaletteOpen: (update: (open: boolean) => boolean) => void,
) {
  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
