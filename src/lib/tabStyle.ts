import type { SessionStatus } from "./types";

/**
 * What a tab does for each status. Each one changes a different thing, so two
 * tabs in two states never look alike from across the room: motion for
 * working, colour for waiting on you, a dot on the face for news.
 */
export type TabTone = {
  /** The ring around the face: spinning while it works, steady amber while it waits. */
  ring: "spin" | "warning" | null;
  /** The pill itself takes a tint: only for what is waiting on you. */
  tint: boolean;
  /** The title in bold, like an unread thread. */
  bold: boolean;
  /** A dot on the face's corner: a finished turn nobody has read, or a failure. */
  badge: "info" | "danger" | null;
};

const QUIET: TabTone = { ring: null, tint: false, bold: false, badge: null };

export function toneOf(status: SessionStatus | null): TabTone {
  switch (status) {
    case "working":
      return { ...QUIET, ring: "spin" };
    case "needs-input":
      return { ...QUIET, ring: "warning", tint: true, bold: true };
    case "error":
      return { ...QUIET, bold: true, badge: "danger" };
    case "done":
      return { ...QUIET, bold: true, badge: "info" };
    default:
      return QUIET;
  }
}
