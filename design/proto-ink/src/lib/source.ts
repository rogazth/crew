import { liveSource, sourceFromLocation } from "@crew/fixtures";
import type { DataSource, ThreadHandle } from "@crew/fixtures";

/**
 * Where the window's data comes from, decided once at boot from the URL:
 * nothing → the demo fixtures, `?stress=heavy` → the big ones, `?source=live`
 * → a real `crewd` through the dev-server bridge. Every surface reads this and
 * nothing reads a fixture module directly, so the three modes are the same app.
 */
export const SOURCE: DataSource = sourceFromLocation(
  typeof location === "undefined" ? "" : location.search,
  () => liveSource(),
);

export const IS_LIVE = SOURCE.kind === "live";

/**
 * `source.thread()` subscribes on construction to forward status, and never
 * unsubscribes — so a handle has to be made once per session, not once per
 * render.
 */
const handles = new Map<string, ThreadHandle>();

export function threadOf(sessionId: string): ThreadHandle {
  let held = handles.get(sessionId);
  if (!held) {
    held = SOURCE.thread(sessionId);
    handles.set(sessionId, held);
  }
  return held;
}

export function forgetThread(sessionId: string) {
  handles.get(sessionId)?.dispose?.();
  handles.delete(sessionId);
}
