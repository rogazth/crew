import { ANSI_DARK, ANSI_LIGHT, rgbToHex } from "./terminalColors";
import type { TerminalKey } from "./terminalKeys";

/** Output this close together reads as one burst of "busy". */
export const ACTIVITY_INTERVAL = 400;
export const ACK_FLUSH_MS = 4;
/** Frames the proposed grid may keep changing before it is applied anyway. */
export const MAX_STABILITY_FRAMES = 8;

export type Grid = { cols: number; rows: number };

/** A CSS colour expression resolved against the page, as `#rrggbb`. */
export function cssColor(expr: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = expr;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return rgbToHex(color || fallback);
}

/** The terminal is the canvas: same background, same text colour, ANSI tuned to it. */
export function palette(dark: boolean, resolve: (expr: string, fallback: string) => string = cssColor) {
  const background = resolve("var(--color-canvas)", dark ? "#1a1a1a" : "#ffffff");
  const foreground = resolve("var(--color-text)", dark ? "#e8eef2" : "#2e2e2e");
  return {
    background,
    foreground,
    cursor: resolve("var(--color-accent)", foreground),
    cursorAccent: background,
    selectionBackground: dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)",
    selectionInactiveBackground: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.07)",
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

/** The dim line a pane keeps once its process is gone. */
export function exitBanner(code: number | null): string {
  return `\r\n\x1b[2m[process exited${code == null ? "" : ` (${code})`}]\x1b[0m`;
}

/** A spawn that failed, in red where the prompt would have been. */
export function spawnErrorLine(error: unknown): string {
  return `\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`;
}

/** The flags a kitty keyboard push or set carries; a sub-parameter list counts as none. */
export function kittyParam(params: (number | number[])[]): number {
  return typeof params[0] === "number" ? params[0] : 0;
}

/** OSC 9 is a notification unless it opens with `4;`, which is progress. */
export const isOsc9Notification = (data: string): boolean => !data.startsWith("4;");

/** OSC 777 carries several commands; only `notify` asks for attention. */
export const isOsc777Notification = (data: string): boolean => data.startsWith("notify");

/** Whether output at `now` is far enough from the last report to count as new activity. */
export function activityDue(now: number, last: number): boolean {
  return now - last >= ACTIVITY_INTERVAL;
}

/** FitAddon throws when the renderer has not measured a cell yet. */
export function proposeGrid(fit: { proposeDimensions(): Grid | undefined }): Grid | null {
  try {
    return fit.proposeDimensions() ?? null;
  } catch {
    return null;
  }
}

/**
 * The grid is applied once two frames agree on it (or it already matches), so
 * a scrollbar wobble mid-resize does not turn into a SIGWINCH loop.
 */
export function gridSettled(next: Grid | null, current: Grid, previous: Grid | null, frames: number): boolean {
  return (
    !next ||
    (next.cols === current.cols && next.rows === current.rows) ||
    (previous?.cols === next.cols && previous?.rows === next.rows) ||
    frames >= MAX_STABILITY_FRAMES
  );
}

/**
 * What a measured grid means for the process. The first measurement spawns it,
 * whatever the size: a pane that measures the same twice would otherwise never
 * start. After that only a real change resizes.
 */
export function sizeStep(last: Grid | null, next: Grid): "spawn" | "resize" | "same" {
  if (!last) return "spawn";
  return next.cols === last.cols && next.rows === last.rows ? "same" : "resize";
}

type KeyTerm = { selectAll(): void; scrollToTop(): void; scrollToBottom(): void };

/** Carries out a resolved key; true leaves the event to xterm. */
export function applyTerminalKey(
  action: TerminalKey,
  term: KeyTerm,
  event: { preventDefault(): void },
  write: (data: string) => void,
): boolean {
  switch (action.type) {
    case "xterm":
      return true;
    case "app":
      return false;
    case "select-all":
      term.selectAll();
      return false;
    case "scroll":
      if (action.to === "top") term.scrollToTop();
      else term.scrollToBottom();
      return false;
    case "input":
      write(action.data);
      event.preventDefault();
      return false;
  }
}

export type PastePayload = { kind: "text"; text: string } | { kind: "image"; file: File } | null;

type Clipboard = { getData(format: string): string; files: Iterable<File> };

/** Text pastes as typed; otherwise the first image travels as a temp file's path. */
export function pastePayload(data: Clipboard | null | undefined): PastePayload {
  const text = data?.getData("text/plain");
  if (text) return { kind: "text", text };
  const image = [...(data?.files ?? [])].find((file) => file.type.startsWith("image/"));
  return image ? { kind: "image", file: image } : null;
}

/**
 * Counts the bytes xterm has parsed and acks them in batches: one flush is
 * pending at a time, so a burst of chunks costs one round trip.
 */
export function createAckFlow(send: (processed: number) => void, delay = ACK_FLUSH_MS) {
  let processed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    send(processed);
  };
  return {
    parsed(bytes: number) {
      processed += bytes;
      if (!timer) timer = setTimeout(flush, delay);
    },
    /** A reattach restarts the count where the daemon's buffer begins. */
    reset(start: number) {
      processed = start;
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
