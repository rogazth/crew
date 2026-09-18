import {
  liveSource,
  sessionRuntime,
  sourceFromLocation,
  type DataSource,
  type MockSession,
  type Session,
  type ThreadHandle,
} from "@crew/fixtures";

/**
 * One switch for the whole app: demo fixtures, a stress world, or a real daemon.
 * Every surface reads through this, so nothing below knows which it got.
 */
export const source: DataSource = sourceFromLocation(
  typeof window === "undefined" ? "" : window.location.search,
  () => liveSource(),
);

export const isLive = source.kind === "live";

const handles = new Map<string, ThreadHandle>();

/** Handles are cached because a handle owns a subscription, not just a read. */
export function threadOf(sessionId: string): ThreadHandle {
  let held = handles.get(sessionId);
  if (!held) {
    held = source.thread(sessionId);
    handles.set(sessionId, held);
  }
  return held;
}

/**
 * The demo menu needs verbs no daemon has — raise an approval, deliver a letter.
 * Only a fixture-backed session can answer them, and for those the source's
 * handle and this object are the same `MockSession`.
 */
export function demoRuntime(session: Session): MockSession {
  return sessionRuntime(session.id, session.status);
}
