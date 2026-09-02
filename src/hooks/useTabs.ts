import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { closeTab, neighbourId, openTab, parseTabs } from "../lib/tabs";
import type { Tab } from "../lib/types";

const CLOSED_LIMIT = 10;

export function useTabs(workspaceId: string | null) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Restoring must finish before the save effect runs, or it persists the empty state.
  const [restored, setRestored] = useState(false);
  const closed = useRef<Tab[]>([]);
  const current = useRef<Tab[]>([]);
  current.current = tabs;

  // Tabs belong to a workspace and survive a restart.
  useEffect(() => {
    setRestored(false);
    setTabs([]);
    setActiveId(null);
    closed.current = [];
    if (!workspaceId) return;

    let cancelled = false;
    api
      .stateGet(`tabs:${workspaceId}`)
      .then((raw) => {
        if (cancelled) return;
        const saved = parseTabs(raw);
        setTabs(saved.tabs);
        setActiveId(saved.activeId);
      })
      .catch(() => {})
      .finally(() => !cancelled && setRestored(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !restored) return;
    void api.stateSet(`tabs:${workspaceId}`, JSON.stringify({ tabs, activeId })).catch(() => {});
  }, [workspaceId, restored, tabs, activeId]);

  const open = useCallback((tab: Tab) => {
    setTabs((prev) => openTab(prev, tab));
    setActiveId(tab.id);
  }, []);

  const close = useCallback((id: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === id);
      if (tab) closed.current = [tab, ...closed.current].slice(0, CLOSED_LIMIT);
      setActiveId((active) => (active === id ? neighbourId(prev, id) : active));
      return closeTab(prev, id);
    });
  }, []);

  const closeForSession = useCallback((sessionId: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.kind === "session" && t.sessionId === sessionId);
      if (!tab) return prev;
      setActiveId((active) => (active === tab.id ? neighbourId(prev, tab.id) : active));
      return closeTab(prev, tab.id);
    });
  }, []);

  const reopen = useCallback(() => {
    const [tab, ...rest] = closed.current;
    if (!tab) return;
    closed.current = rest;
    setTabs((prev) => openTab(prev, tab));
    setActiveId(tab.id);
  }, []);

  /** Chromium's ⌃⇥: strip order, wrapping at both ends. */
  const step = useCallback((delta: number) => {
    setActiveId((active) => {
      const list = current.current;
      if (list.length === 0) return active;
      const index = list.findIndex((tab) => tab.id === active);
      const next = (((index === -1 ? 0 : index + delta) % list.length) + list.length) % list.length;
      return list[next]?.id ?? active;
    });
  }, []);

  /** Browser ⌘1–⌘8; ⌘9 is the last tab, so pass -1. */
  const activate = useCallback((index: number) => {
    const list = current.current;
    const tab = index < 0 ? list.at(-1) : list[index];
    if (tab) setActiveId(tab.id);
  }, []);

  const active = tabs.find((t) => t.id === activeId) ?? null;
  return { tabs, active, open, close, closeForSession, reopen, step, activate, select: setActiveId };
}
