import { useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { parseFaces, type AgentFace, type AgentFaces } from "../lib/agentAvatar";

const KEY = "agent:faces";

let faces: AgentFaces = {};
let requested = false;
const listeners = new Set<() => void>();

/**
 * What is stored, under the faces picked here since: those are on their way to
 * the store. crewd also writes one, for a conversation split off a terminal.
 */
export function reloadAgentFaces() {
  api
    .stateGet(KEY)
    .then((raw) => publish({ ...parseFaces(raw), ...faces }))
    .catch(() => {});
}

function publish(next: AgentFaces) {
  faces = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Faces agents were given by hand, by session id; one read for every avatar on screen. */
export function useAgentFaces() {
  const current = useSyncExternalStore(subscribe, () => faces);

  useEffect(() => {
    if (requested) return;
    requested = true;
    reloadAgentFaces();
  }, []);

  return current;
}

/** A face picked in the agent sheet; an empty one hands the agent back to the default. */
export function setAgentFace(sessionId: string, face: AgentFace) {
  const next = { ...faces };
  if (face.style || face.seed) next[sessionId] = face;
  else delete next[sessionId];
  publish(next);
  void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
}
