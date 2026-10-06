import { useCallback, useEffect, useRef } from "react";
import { onNotificationClick } from "../lib/host";
import { markSeen, setVisibleSession } from "../lib/notifications";
import type { NotificationTarget } from "../lib/notify";
import type { Session } from "../lib/types";

type Deps = {
  /** Every workspace's sessions this window has listed. */
  sessions: Session[];
  activeWorkspaceId: string | null;
  /** The session whose tab is on screen, with no page over it. */
  visibleSessionId: string | null;
  activate: (workspaceId: string) => void;
  openSession: (session: Session) => void;
  closePage: () => void;
};

/**
 * Where a notification leads. A click on a banner, or Open on a toast, brings
 * up its session; one in another workspace waits for that workspace to show
 * and its sessions to arrive, then opens. Also tells the dispatcher which
 * session is on screen, since news of it is already in front of the user,
 * and its banners can come down.
 */
export function useNotificationTarget({
  sessions,
  activeWorkspaceId,
  visibleSessionId,
  activate,
  openSession,
  closePage,
}: Deps) {
  const pending = useRef<NotificationTarget | null>(null);

  useEffect(() => setVisibleSession(visibleSessionId), [visibleSessionId]);
  // Back in front on the session a banner was about.
  useEffect(() => {
    window.addEventListener("focus", markSeen);
    return () => window.removeEventListener("focus", markSeen);
  }, []);

  const settle = useCallback(() => {
    const target = pending.current;
    if (!target || target.workspaceId !== activeWorkspaceId) return;
    const session = sessions.find((row) => row.id === target.sessionId);
    if (!session) return;
    pending.current = null;
    openSession(session);
  }, [activeWorkspaceId, openSession, sessions]);

  useEffect(settle, [settle]);

  const open = useCallback(
    (target: NotificationTarget) => {
      closePage();
      pending.current = target;
      if (target.workspaceId === activeWorkspaceId) settle();
      else activate(target.workspaceId);
    },
    [activate, activeWorkspaceId, closePage, settle],
  );

  useEffect(() => onNotificationClick((target) => target && open(target)), [open]);

  return open;
}
