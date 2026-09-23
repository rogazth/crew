import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api';
import {
  activateTab,
  closeSessionTab,
  closeTab,
  NO_TABS,
  openTab,
  panesOf,
  patchBrowserTab,
  parseTabs,
  reopenTab,
  selectTab,
  stepTab,
  type TabRegistry,
  type TabState,
} from '../lib/tabs';
import type { Tab } from '../lib/types';

/**
 * Tabs belong to a workspace and survive a restart. A workspace this window has
 * shown keeps its entry for the rest of the run: its panes stay mounted behind
 * the one on screen, which is what keeps their processes alive across a switch.
 */
export function useTabs(workspaceId: string | null) {
  const [registry, setRegistry] = useState<TabRegistry>({});
  // A workspace is read once. Re-reading on every switch would hand back the
  // saved tabs while the live ones are still on screen.
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const id = workspaceId;
    if (!id || asked.current.has(id)) return;
    asked.current.add(id);
    void api
      .stateGet(`tabs:${id}`)
      .then(parseTabs)
      .catch(() => NO_TABS)
      .then((restored) => setRegistry((prev) => (prev[id] ? prev : { ...prev, [id]: restored })));
  }, [workspaceId]);

  const state = workspaceId ? registry[workspaceId] : undefined;

  // Any workspace can change, not just the one on screen: a page behind a
  // workspace switch still finishes loading and retitles its tab.
  const saved = useRef<TabRegistry>({});
  useEffect(() => {
    for (const [id, next] of Object.entries(registry)) {
      if (saved.current[id] === next) continue;
      saved.current[id] = next;
      const { tabs, activeId } = next;
      void api.stateSet(`tabs:${id}`, JSON.stringify({ tabs, activeId })).catch(() => {});
    }
  }, [registry]);

  const mutateIn = useCallback((id: string, step: (state: TabState) => TabState) => {
    setRegistry((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const next = step(current);
      return next === current ? prev : { ...prev, [id]: next };
    });
  }, []);

  /** Tab actions from the keyboard and the strip aim at the workspace on screen. */
  const mutate = useCallback(
    (step: (state: TabState) => TabState) => {
      if (workspaceId) mutateIn(workspaceId, step);
    },
    [workspaceId, mutateIn],
  );

  const open = useCallback((tab: Tab) => mutate((s) => openTab(s, tab)), [mutate]);
  const close = useCallback((id: string) => mutate((s) => closeTab(s, id)), [mutate]);
  const closeForSession = useCallback(
    (sessionId: string) => mutate((s) => closeSessionTab(s, sessionId)),
    [mutate],
  );
  const reopen = useCallback(() => mutate(reopenTab), [mutate]);
  const step = useCallback((delta: number) => mutate((s) => stepTab(s, delta)), [mutate]);
  const activate = useCallback((index: number) => mutate((s) => activateTab(s, index)), [mutate]);
  const select = useCallback((id: string | null) => mutate((s) => selectTab(s, id)), [mutate]);
  /** A page asked for a tab: it lands in the page's own workspace, beside it. */
  const openIn = useCallback(
    (id: string, tab: Tab, opts?: { after?: string; background?: boolean }) =>
      mutateIn(id, (s) => openTab(s, tab, opts)),
    [mutateIn],
  );
  const patchBrowser = useCallback(
    (id: string, tabId: string, patch: { url?: string; title?: string }) =>
      mutateIn(id, (s) => patchBrowserTab(s, tabId, patch)),
    [mutateIn],
  );

  /** The workspace is gone: its panes unmount, which ends what they were running. */
  const dropWorkspace = useCallback((id: string) => {
    asked.current.delete(id);
    delete saved.current[id];
    setRegistry((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const panes = useMemo(() => panesOf(registry, workspaceId), [registry, workspaceId]);
  const tabs = state?.tabs ?? NO_TABS.tabs;
  const active = tabs.find((t) => t.id === state?.activeId) ?? null;
  return {
    tabs,
    active,
    panes,
    open,
    close,
    closeForSession,
    reopen,
    step,
    activate,
    select,
    openIn,
    patchBrowser,
    dropWorkspace,
  };
}
