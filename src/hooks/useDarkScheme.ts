import { useEffect, useState } from "react";
import { isDark, onSchemeChange } from "../lib/markdown/mermaid";

/** Whether the page renders dark, following the OS scheme and the root's `data-mode`. */
export function useDarkScheme(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => onSchemeChange(() => setDark(isDark())), []);
  return dark;
}
