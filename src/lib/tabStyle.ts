import type { SessionStatus } from "./types";

/**
 * What a tab does for each status, beside the signal in its trailing slot:
 * the pill takes a tint for what waits on you, and the title goes bold for
 * news, like an unread thread. The provider's face is identity only.
 */
export type TabTone = {
  /** The pill itself takes a tint: only for what is waiting on you. */
  tint: boolean;
  /** The title in bold, like an unread thread. */
  bold: boolean;
};

const QUIET: TabTone = { tint: false, bold: false };

export function toneOf(status: SessionStatus | null): TabTone {
  switch (status) {
    case "needs-input":
      return { tint: true, bold: true };
    case "error":
    case "done":
      return { ...QUIET, bold: true };
    default:
      return QUIET;
  }
}
