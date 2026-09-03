import { useEffect, useMemo, useRef } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { keysFor, registerCommand, type CommandId } from "../lib/commands";

/**
 * requireReset re-arms on releasing the key *or* a modifier, and on a non-US layout the
 * bracket keyup reports a character that never matches `]`. Cycling would then fire once
 * per ⌘⇧ hold instead of once per tap, so these two keep the repeat.
 */
const REPEATABLE = new Set<CommandId>(["next-tab", "prev-tab"]);

/**
 * Binds a command's keys and publishes its handler, so the palette can run the
 * same command without a keyboard. A command exists only while someone is
 * mounted to handle it — that is the `when`.
 */
export function useCommand(id: CommandId, handler: () => void) {
  useCommands(useMemo(() => ({ [id]: handler }), [id, handler]));
}

/** Register several handlers in one place (the app chrome). */
export function useCommands(map: { [K in CommandId]?: () => void }) {
  const mapRef = useRef(map);
  useEffect(() => {
    mapRef.current = map;
  });

  // Sorted so the array useHotkeys diffs by index stays stable across renders.
  const ids = (Object.keys(map) as CommandId[]).filter((id) => map[id]).sort();
  const key = ids.join("\0");

  useHotkeys(
    useMemo(
      () =>
        ids.map((id) => ({
          hotkey: keysFor(id),
          callback: () => mapRef.current[id]?.(),
          options: { requireReset: !REPEATABLE.has(id) },
        })),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [key],
    ),
  );

  useEffect(() => {
    const unbinds = ids.map((id) => registerCommand(id, () => mapRef.current[id]?.()));
    return () => {
      for (const unbind of unbinds) unbind();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
