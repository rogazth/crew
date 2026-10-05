import { useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { parseFaces, type BotFace, type BotFaces } from "../lib/botAvatar";

const KEY = "bot:faces";

let faces: BotFaces = {};
let requested = false;
const listeners = new Set<() => void>();

/**
 * What is stored, under the faces picked here since: those are on their way to
 * the store. crewd also writes one, for a conversation split off a terminal.
 */
export function reloadBotFaces() {
  api
    .stateGet(KEY)
    .then((raw) => publish({ ...parseFaces(raw), ...faces }))
    .catch(() => {});
}

function publish(next: BotFaces) {
  faces = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Faces bots were given by hand, by session id; one read for every avatar on screen. */
export function useBotFaces() {
  const current = useSyncExternalStore(subscribe, () => faces);

  useEffect(() => {
    if (requested) return;
    requested = true;
    reloadBotFaces();
  }, []);

  return current;
}

/** A face picked in the bot sheet; an empty one hands the bot back to the default. */
export function setBotFace(sessionId: string, face: BotFace) {
  const next = { ...faces };
  if (face.style || face.seed) next[sessionId] = face;
  else delete next[sessionId];
  publish(next);
  void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
}
