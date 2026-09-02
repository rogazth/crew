import { useEffect, useState } from "react";

/** True while ⌘ (or Ctrl off macOS) is down, so chrome can reveal its shortcuts. */
export function useModKeyHeld(): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setHeld(event.metaKey || event.ctrlKey);
    // ⌘⇥ to another app never delivers the keyup, so the hint would stick.
    const clear = () => setHeld(false);

    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  return held;
}
