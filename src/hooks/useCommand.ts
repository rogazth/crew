import { useEffect, useRef } from "react";
import {
  commandForEvent,
  registerCommand,
  runCommand,
  type CommandId,
} from "../lib/commands";

let listenCount = 0;

function onKeyDown(event: KeyboardEvent) {
  if (event.isComposing || event.repeat) return;
  const id = commandForEvent(event);
  if (!id) return;
  event.preventDefault();
  runCommand(id);
}

function attachListener() {
  if (listenCount === 0) window.addEventListener("keydown", onKeyDown, true);
  listenCount += 1;
}

function detachListener() {
  listenCount -= 1;
  if (listenCount === 0) window.removeEventListener("keydown", onKeyDown, true);
}

/** Register a handler for as long as the caller is mounted. */
export function useCommand(id: CommandId, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unbind = registerCommand(id, () => handlerRef.current());
    attachListener();
    return () => {
      unbind();
      detachListener();
    };
  }, [id]);
}

/** Register several handlers in one place (the app chrome). */
export function useCommands(map: { [K in CommandId]?: () => void }) {
  const mapRef = useRef(map);
  mapRef.current = map;

  const key = commandMapKey(map);

  useEffect(() => {
    const unbinds: Array<() => void> = [];
    for (const id of Object.keys(mapRef.current) as CommandId[]) {
      if (!mapRef.current[id]) continue;
      unbinds.push(registerCommand(id, () => mapRef.current[id]?.()));
      attachListener();
    }
    return () => {
      for (const unbind of unbinds) {
        unbind();
        detachListener();
      }
    };
  }, [key]);
}

function commandMapKey(map: { [K in CommandId]?: () => void }): string {
  return (Object.keys(map) as CommandId[]).filter((id) => map[id]).sort().join("\0");
}
