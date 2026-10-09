import { useSyncExternalStore } from "react";
import { client } from "./client";
import type { FastMode } from "./protocol";

/**
 * Whether this account can use Claude's fast mode, which decides whether the
 * Fast toggle shows. The daemon checks in the background and pushes
 * `fast-mode-changed`; this keeps the latest, asked for the first time anything
 * listens and again after a reconnect.
 */

type Listener = () => void;

let current: FastMode | null = null;
/** Bumped by every reading heard: a request that went out before one is older than it. */
let heard = 0;
const listeners = new Set<Listener>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("fast-mode-changed", (payload) => set(payload as FastMode));
  client.onReconnect(() => void fetchMode());
  void fetchMode();
}

function set(mode: FastMode) {
  heard += 1;
  current = mode;
  for (const listener of listeners) listener();
}

async function fetchMode(): Promise<void> {
  const before = heard;
  try {
    const mode = await client.request<FastMode>("agent_fast_mode");
    if (heard === before) set(mode);
  } catch {
    // A crewd that predates the check has nothing to say, so the toggle stays hidden.
  }
}

function subscribe(listener: Listener): () => void {
  ensureBridge();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The account's Claude fast mode as the daemon last read it; null until it has said. */
export function useClaudeFastMode(): FastMode | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether the Fast toggle shows for Claude: the account can use fast mode, or a rate limit has it cooling down. */
export function claudeFastShown(mode: FastMode | null): boolean {
  return mode?.availability === "available" || mode?.availability === "cooldown";
}

/** The Fast toggle's title for Claude. A cooldown says when fast resumes. */
export function claudeFastTitle(mode: FastMode | null, on: boolean): string {
  if (mode?.availability === "cooldown") return "Rate limited — fast resumes after a cooldown";
  return on ? "Running in fast mode — click for standard" : "A faster run of this model";
}
