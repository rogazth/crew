import { useCallback, useEffect, useState } from "react";
import { DEFAULT_COLOR_MODE, parseColorMode, type ColorMode } from "../lib/colorMode";
import { colorModeHost } from "../lib/host";

/** Main owns the mode so the window opens in it; this reads and writes it there. */
export function useColorMode() {
  const [mode, setMode] = useState<ColorMode>(DEFAULT_COLOR_MODE);

  useEffect(() => {
    let cancelled = false;
    colorModeHost()
      ?.get()
      .then((raw) => !cancelled && setMode(parseColorMode(raw)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: ColorMode) => {
    setMode(next);
    void colorModeHost()?.set(next).catch(() => {});
  }, []);

  return { mode, update, available: colorModeHost() !== null };
}
