import { useEffect, type RefObject } from "react";
import { ARROWS, nearest } from "../lib/spatial";

/**
 * Arrow keys move focus between the `[data-nav]` items under `root` by where
 * they sit on screen, so the rail, the agent grid and the session rows share
 * one set of keys. A field keeps its arrows.
 */
export function useSpatialKeys(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKey = (event: KeyboardEvent) => {
      const dir = ARROWS[event.key];
      if (!dir || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const from = (event.target as HTMLElement).closest<HTMLElement>("[data-nav]");
      if (!from || !el.contains(from)) return;
      const items = [...el.querySelectorAll<HTMLElement>("[data-nav]")].filter(
        (item) => item !== from && item.offsetParent !== null && !item.closest("[inert]"),
      );
      const index = nearest(
        from.getBoundingClientRect(),
        items.map((item) => item.getBoundingClientRect()),
        dir,
      );
      event.preventDefault();
      const next = items[index];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [root]);
}

/** Puts the keyboard on the sidebar item that stands for what is open, else the first one. */
export function focusSidebar(scope: "rail" | "panel") {
  const root = document.querySelector(`[data-sidebar-${scope}]`);
  const target =
    root?.querySelector<HTMLElement>("[data-nav][aria-current]") ??
    root?.querySelector<HTMLElement>("[data-nav]");
  target?.focus();
}
