import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api';
import {
  activateTab,
  closeSessionTab,
  closeTab,
  lastUsed,
  NO_TABS,
  openTab,
  panesOf,
  patchBrowserTab,
  parseTabs,
  reopenTab,
  reorderTabs,
  selectTab,
  stepTab,
  type TabRegistry,
  type TabState,
  withRecent,
} from '../lib/tabs';
import type { Tab } from '../lib/types';
import { discardEdits, fileName, unsavedTabs } from '../lib/unsavedEdits';

/** The strips dropping `id` takes: its own, and a workspace's worktrees' too. */
const within = (id: string, key: string) => key === id || (!id.includes('@') && key.startsWith(`${id}@`));

/**
 * Tabs belong to a context — a workspace, or one worktree of it when tabs are
 * kept per worktree — and survive a restart. A context this window has shown
 * keeps its entry for the rest of the run: its panes stay mounted behind the one
 * on screen, which is what keeps their processes alive across a switch.
 */
export function useTabs(workspaceId: string | null) {
  const [registry, setRegistry] = useState<TabRegistry>({});
  // A workspace is read once. Re-reading on every switch would hand back the
  // saved tabs while the live ones are still on screen.
  const asked = useRef(new Set<string>());
  // Only a context whose saved tabs have been read may be written back: one
  // seeded early would otherwise overwrite them before they are read.
  const restoredIds = useRef(new Set<string>());

  /** Reads a context's saved strip, once, and merges in whatever was opened there before it arrived. */
  const restore = useCallback((id: string) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    void api
      .stateGet(`tabs:${id}`)
      .then(parseTabs)
      .catch(() => NO_TABS)
      // A tab opened into this context before its saved ones arrived joins them.
      .then((restored) => {
        restoredIds.current.add(id);
        setRegistry((prev) => {
          const early = prev[id];
          if (!early) return { ...prev, [id]: restored };
          const known = new Set(restored.tabs.map((tab) => tab.id));
          const tabs = [...restored.tabs, ...early.tabs.filter((tab) => !known.has(tab.id))];
          return { ...prev, [id]: withRecent({ ...restored, tabs, activeId: early.activeId ?? restored.activeId }) };
        });
      });
  }, []);

  useEffect(() => {
    if (workspaceId) restore(workspaceId);
  }, [workspaceId, restore]);

  const state = workspaceId ? registry[workspaceId] : undefined;

  // Any workspace can change, not just the one on screen: a page behind a
  // workspace switch still finishes loading and retitles its tab.
  const saved = useRef<TabRegistry>({});
  useEffect(() => {
    for (const [id, next] of Object.entries(registry)) {
      if (saved.current[id] === next || !restoredIds.current.has(id)) continue;
      saved.current[id] = next;
      const { tabs, activeId, recent } = next;
      void api.stateSet(`tabs:${id}`, JSON.stringify({ tabs, activeId, recent })).catch(() => {});
    }
  }, [registry]);

  // Every change keeps the strip's recent order, so the tab brought on screen
  // is the newest, and a closed one leaves it.
  const mutateIn = useCallback((id: string, step: (state: TabState) => TabState) => {
    setRegistry((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const next = withRecent(step(current));
      return next === current ? prev : { ...prev, [id]: next };
    });
  }, []);

  /** Like mutateIn, for a context that may not be restored yet: it starts empty and merges later. */
  const seedIn = useCallback((id: string, step: (state: TabState) => TabState) => {
    setRegistry((prev) => {
      const current = prev[id] ?? NO_TABS;
      const next = withRecent(step(current));
      return next === prev[id] ? prev : { ...prev, [id]: next };
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
  /** A session's tab can live in any context, so every one of them lets it go. */
  const closeForSession = useCallback(
    (sessionId: string) =>
      setRegistry((prev) => {
        let changed = false;
        const next: TabRegistry = {};
        for (const [id, state] of Object.entries(prev)) {
          next[id] = withRecent(closeSessionTab(state, sessionId));
          if (next[id] !== state) changed = true;
        }
        return changed ? next : prev;
      }),
    [],
  );
  const reopen = useCallback(() => mutate(reopenTab), [mutate]);
  const step = useCallback((delta: number) => mutate((s) => stepTab(s, delta)), [mutate]);
  const activate = useCallback((index: number) => mutate((s) => activateTab(s, index)), [mutate]);
  const select = useCallback((id: string | null) => mutate((s) => selectTab(s, id)), [mutate]);
  const reorder = useCallback((ids: string[]) => mutate((s) => reorderTabs(s, ids)), [mutate]);
  /** The tab last on screen of those `keep` takes, or none when it takes none. */
  const selectLastUsed = useCallback(
    (keep: (tab: Tab) => boolean) => mutate((s) => selectTab(s, lastUsed(s, keep)?.id ?? null)),
    [mutate],
  );
  /**
   * Brings `tabId` on screen in a context that may not be read yet: the tab
   * waits as its active one and takes over once the saved tabs arrive.
   */
  const selectIn = useCallback((id: string, tabId: string) => seedIn(id, (s) => selectTab(s, tabId)), [seedIn]);
  /** A tab for a context other than the one on screen: a page's own, or the worktree about to show. */
  const openIn = useCallback(
    (id: string, tab: Tab, opts?: { after?: string; background?: boolean }) =>
      seedIn(id, (s) => openTab(s, tab, opts)),
    [seedIn],
  );
  /**
   * A tab an agent needs in a context: it joins the strip behind whatever is
   * on screen, and the context's saved strip is read, so the tab is saved
   * with the rest instead of living only in this window.
   */
  const adopt = useCallback(
    (id: string, tab: Tab) => {
      seedIn(id, (s) => (s.tabs.some((t) => t.id === tab.id) ? s : openTab(s, tab, { background: true })));
      restore(id);
    },
    [seedIn, restore],
  );
  const patchBrowser = useCallback(
    (id: string, tabId: string, patch: { url?: string; title?: string }) =>
      mutateIn(id, (s) => patchBrowserTab(s, tabId, patch)),
    [mutateIn],
  );

  /** The strips as of the last render, for reads outside one. */
  const live = useRef(registry);
  useEffect(() => {
    live.current = registry;
  }, [registry]);

  /** The files whose unsaved edits dropping `id` would lose, for the prompt that asks. */
  const unsavedIn = useCallback(
    (id: string) =>
      Object.entries(live.current).flatMap(([key, strip]) =>
        within(id, key) ? unsavedTabs(strip.tabs).map(fileName) : [],
      ),
    [],
  );

  /**
   * The workspace, or one worktree of it, is gone: its panes unmount, which ends
   * what they were running. A workspace takes its worktrees' strips with it.
   * Its saved strip goes too, since nothing writes it again and the same
   * worktree made anew would restore it. crewd drops a removed workspace's
   * worktree strips itself, the ones this window never read included. The
   * removal was confirmed, so its files' unsaved edits go as well.
   */
  const dropWorkspace = useCallback((id: string) => {
    const gone = (key: string) => within(id, key);
    for (const [key, strip] of Object.entries(live.current)) {
      if (gone(key)) for (const tab of unsavedTabs(strip.tabs)) discardEdits(tab.path);
    }
    for (const key of asked.current) if (gone(key)) asked.current.delete(key);
    for (const key of restoredIds.current) if (gone(key)) restoredIds.current.delete(key);
    for (const key of Object.keys(saved.current)) if (gone(key)) delete saved.current[key];
    void api.stateDelete(`tabs:${id}`).catch(() => {});
    setRegistry((prev) => {
      const keys = Object.keys(prev).filter(gone);
      if (keys.length === 0) return prev;
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });
  }, []);

  /** Strips as they stand: live when this window holds them, else as crewd saved them. */
  const strips = useCallback(async (ids: string[]) => {
    const stored = await Promise.all(
      ids.map((id) => api.stateGet(`tabs:${id}`).then(parseTabs).catch(() => NO_TABS)),
    );
    return Object.fromEntries(ids.map((id, at) => [id, live.current[id] ?? stored[at]!]));
  }, []);

  /**
   * Strips traded for others at once, the way switching between tabs per
   * worktree and all together does: `next` takes over, and the `gone` strips
   * go, here and in crewd. A gone strip stays read, so the switch never brings
   * back the copy crewd is still deleting.
   */
  const replace = useCallback((next: TabRegistry, gone: string[]) => {
    for (const id of Object.keys(next)) {
      asked.current.add(id);
      restoredIds.current.add(id);
    }
    for (const id of gone) {
      restoredIds.current.delete(id);
      delete saved.current[id];
      void api.stateDelete(`tabs:${id}`).catch(() => {});
    }
    setRegistry((prev) => {
      const out = { ...prev, ...next };
      for (const id of gone) delete out[id];
      return out;
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
    reorder,
    selectLastUsed,
    selectIn,
    openIn,
    adopt,
    patchBrowser,
    dropWorkspace,
    unsavedIn,
    strips,
    replace,
  };
}
