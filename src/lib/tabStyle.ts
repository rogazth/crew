import type { SessionStatus } from "./types";

/**
 * What a tab does for each status, beside the signal in its trailing slot:
 * the title goes bold for what waits on you and for news, like an unread
 * thread. The pill itself never takes the status's colour: the dot says it.
 */
export type TabTone = {
  /** The title in bold, like an unread thread. */
  bold: boolean;
};

const QUIET: TabTone = { bold: false };

export function toneOf(status: SessionStatus | null): TabTone {
  switch (status) {
    case "needs-input":
    case "error":
    case "done":
      return { bold: true };
    default:
      return QUIET;
  }
}
