import { useEffect } from "react";

/**
 * A three-message bus for the two commands a surface owns rather than the shell:
 * find-in-terminal, save-file, and the workspace "open folder" dialog. Routing
 * them through the store would put transient intent in persistent state.
 */
export type InkEvent = "terminal:find" | "terminal:zoom" | "file:save" | "workspace:open";

export function emit(name: InkEvent, detail?: unknown) {
  window.dispatchEvent(new CustomEvent(`ink:${name}`, { detail }));
}

export function useBus(name: InkEvent, handler: (detail: unknown) => void) {
  useEffect(() => {
    const listener = (event: Event) => handler((event as CustomEvent).detail);
    window.addEventListener(`ink:${name}`, listener);
    return () => window.removeEventListener(`ink:${name}`, listener);
  }, [name, handler]);
}
