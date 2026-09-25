import { useEffect, useMemo, useRef } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { allKeysFor, registerCommand, repeatable, type CommandId } from "../lib/commands";

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
        ids.flatMap((id) =>
          allKeysFor(id).map((hotkey) => ({
              hotkey,
              callback: (event: KeyboardEvent) => {
                // Auto-repeat is dropped via `event.repeat`, not requireReset: requireReset
                // re-arms on keyup, and macOS sends no keyup for keys pressed while ⌘ is held,
                // so ⌘1 ⌘3 ⌘1 in one hold would ignore the second ⌘1. Only commands marked
                // `repeat` keep firing while held.
                if (event.repeat && !repeatable(id)) return;
                mapRef.current[id]?.();
              },
            })),
        ),
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
