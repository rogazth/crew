// PROTOTYPE — throwaway. The redesign laid over the real app. Three things the
// dev bar sets, kept in localStorage so Electron (no address bar) keeps them:
//
//   direction  a | b | c   the redesign's colourway, keyed on <html data-direction>; a build
//              that is not dev stays `off`, which is the app as it ships
//   theme      system | light | dark   forces color-scheme on <html>, in the app and the gallery alike
//   update     none | available | downloading | ready   a simulated app update, for the pill and the About page
//
// Any direction but `off` turns the redesigned surfaces on: `useRedesign()`. In dev it is always on.
import { useSyncExternalStore } from "react";
import { colorModeHost } from "../../lib/host";

export const DIRECTIONS = [
  { key: "a", name: "Ink" },
  { key: "b", name: "Crew" },
  { key: "c", name: "Cobalt" },
] as const;

export type Direction = "off" | (typeof DIRECTIONS)[number]["key"];
export type Theme = "system" | "light" | "dark";
export type UpdatePhase = "none" | "available" | "downloading" | "ready";

type State = { direction: Direction; theme: Theme; update: UpdatePhase; progress: number };

const KEYS = { direction: "crew-proto-direction", theme: "crew-proto-theme", update: "crew-proto-update" } as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Kept for this page only.
  }
}

function initial(): State {
  if (!import.meta.env.DEV) return { direction: "off", theme: "system", update: "none", progress: 0 };
  const url = new URLSearchParams(location.search);
  const direction = url.get("direction") ?? read(KEYS.direction) ?? "a";
  const theme = url.get("theme") ?? read(KEYS.theme) ?? "system";
  const update = read(KEYS.update) ?? "none";
  return {
    direction: DIRECTIONS.some((d) => d.key === direction) ? (direction as Direction) : "a",
    theme: theme === "light" || theme === "dark" ? theme : "system",
    update: (["none", "available", "downloading", "ready"] as const).includes(update as UpdatePhase) ? (update as UpdatePhase) : "none",
    progress: update === "ready" ? 1 : 0,
  };
}

let state: State = initial();
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  apply();
  for (const listener of listeners) listener();
}

function apply() {
  const root = document.documentElement;
  if (state.direction === "off") delete root.dataset.direction;
  else root.dataset.direction = state.direction;
  root.style.colorScheme = state.theme === "system" || colorModeHost() ? "" : state.theme;
  write(KEYS.direction, state.direction === "off" ? null : state.direction);
  write(KEYS.theme, state.theme === "system" ? null : state.theme);
  write(KEYS.update, state.update === "none" ? null : state.update);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useProto(): State {
  return useSyncExternalStore(subscribe, () => state);
}

/** The redesigned surfaces are on whenever a direction is. */
export function useRedesign(): boolean {
  return useProto().direction !== "off";
}

export function readDirection(): Direction {
  return state.direction;
}

export function applyDirection(direction: Direction) {
  set({ direction });
}

/**
 * In the app, the real colour mode, so diffs, code and terminals that read the
 * OS scheme follow too; in a browser, `color-scheme` on <html> is all there is.
 */
export function setTheme(theme: Theme) {
  const host = colorModeHost();
  if (host) void host.set(theme);
  set({ theme });
}

let ticker: number | undefined;

/** Walks the simulated update: available → downloading (ticks to 100%) → ready. */
export function setUpdate(update: UpdatePhase) {
  window.clearInterval(ticker);
  set({ update, progress: update === "ready" ? 1 : 0 });
  if (update !== "downloading") return;
  ticker = window.setInterval(() => {
    const progress = Math.min(1, state.progress + 0.04 + Math.random() * 0.05);
    if (progress >= 1) {
      window.clearInterval(ticker);
      set({ update: "ready", progress: 1 });
    } else set({ progress });
  }, 220);
}

export function boot() {
  apply();
  if (state.update === "downloading") setUpdate("downloading");
}

/** The release a simulated update offers. */
export const RELEASE = {
  version: "0.3.14",
  current: "0.3.13",
  size: "48.2 MB",
  date: "October 14, 2026",
  notes: [
    { kind: "new", text: "Big attachments upload to remote machines in pieces, with progress." },
    { kind: "new", text: "Files picked in the dialog are sent to the remote machine too." },
    { kind: "improved", text: "A nameless shell shows its command as the row's preview." },
    { kind: "fixed", text: "Background subagents no longer leave a stray wake note." },
  ],
} as const;
