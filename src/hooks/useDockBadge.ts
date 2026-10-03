import { useEffect, useRef, useState } from "react";
import { notificationsHost } from "../lib/host";
import { attentionOf, NO_BADGE, nextBadge } from "../lib/notificationBadge";
import { isPaused } from "../lib/notificationPrefs";
import type { Session } from "../lib/types";
import { useNotificationPrefs } from "./useNotificationPrefs";

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return focused;
}

/**
 * The Dock icon counts the sessions that started waiting on the user while
 * Crew was in the background; bringing Crew forward clears it. With bounce
 * on, a count that goes up bounces the icon once.
 */
export function useDockBadge(sessions: Session[]) {
  const { prefs } = useNotificationPrefs();
  const focused = useWindowFocused();
  const state = useRef(NO_BADGE);
  const sent = useRef<number | null>(null);
  const shown = prefs.enabled && prefs.badge;

  useEffect(() => {
    const host = notificationsHost();
    if (!host) return;
    const prev = state.current;
    const next = nextBadge(prev, attentionOf(sessions), focused);
    state.current = next;
    const count = shown ? next.count : 0;
    if (count === sent.current) return;
    const rose = count > (sent.current ?? 0);
    sent.current = count;
    host.setBadge({ count, bounce: rose && prefs.bounce && !isPaused(prefs, Date.now()) });
  }, [focused, prefs, sessions, shown]);
}
