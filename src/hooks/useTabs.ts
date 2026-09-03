import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import {
  activateTab,
  closeSessionTab,
  closeTab,
  NO_TABS,
  openTab,
  parseTabs,
  reopenTab,
  selectTab,
  stepTab,
  type TabState,
} from "../lib/tabs";
import type { Tab } from "../lib/types";

export function useTabs(workspaceId: string | null) {
  const [state, setState] = useState<TabState>(NO_TABS);
  // Restoring must finish before the save effect runs, or it persists the empty state.
  const [restored, setRestored] = useState(false);

  // Tabs belong to a workspace and survive a restart.
  useEffect(() => {
    setRestored(false);
    setState(NO_TABS);
    if (!workspaceId) return;

    let cancelled = false;
    api
      .stateGet(`tabs:${workspaceId}`)
      .then((raw) => {
        if (!cancelled) setState(parseTabs(raw));
      })
      .catch(() => {})
      .finally(() => !cancelled && setRestored(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !restored) return;
    const { tabs, activeId } = state;
    void api.stateSet(`tabs:${workspaceId}`, JSON.stringify({ tabs, activeId })).catch(() => {});
  }, [workspaceId, restored, state]);

  const open = useCallback((tab: Tab) => setState((s) => openTab(s, tab)), []);
  const close = useCallback((id: string) => setState((s) => closeTab(s, id)), []);
  const closeForSession = useCallback(
    (sessionId: string) => setState((s) => closeSessionTab(s, sessionId)),
    [],
  );
  const reopen = useCallback(() => setState(reopenTab), []);
  const step = useCallback((delta: number) => setState((s) => stepTab(s, delta)), []);
  const activate = useCallback((index: number) => setState((s) => activateTab(s, index)), []);
  const select = useCallback((id: string | null) => setState((s) => selectTab(s, id)), []);

  const active = state.tabs.find((t) => t.id === state.activeId) ?? null;
  return { tabs: state.tabs, active, open, close, closeForSession, reopen, step, activate, select };
}
