import { useEffect, useMemo, useRef } from "react";
import { liveCommands, registerCommand, runCommand, type CommandId } from "../lib/commands";
import { IS_MAC } from "../lib/hotkey";
import { keyboardLayout, watchKeyboardLayout } from "../lib/keyboardLayout";
import { resolveForward } from "../lib/keymap";

let listening = false;

/**
 * One keydown listener for every command, matching through the same keymap a
 * focused page's keys go through in the main process, so a chord means the
 * same thing wherever focus is. Auto-repeat runs only commands marked
 * `repeat`; the rest fire once per press.
 */
function listen() {
  if (listening) return;
  listening = true;
  watchKeyboardLayout();
  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const forward = resolveForward(
      {
        type: "keyDown",
        key: event.key,
        code: event.code,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        isAutoRepeat: event.repeat,
      },
      liveCommands(),
      IS_MAC,
      keyboardLayout(),
    );
    if (!forward) return;
    event.preventDefault();
    event.stopPropagation();
    if (forward.run) runCommand(forward.id as CommandId);
  });
}

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

  const ids = (Object.keys(map) as CommandId[]).filter((id) => map[id]).sort();
  const key = ids.join("\0");

  useEffect(() => {
    listen();
    const unbinds = ids.map((id) => registerCommand(id, () => mapRef.current[id]?.()));
    return () => {
      for (const unbind of unbinds) unbind();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
