import { useEffect, useRef } from "react";
import { SETTINGS_SECTIONS } from "@crew/fixtures";
import type { SettingsSectionId } from "@crew/fixtures";
import { store, useApp, type State } from "./store";

/**
 * A hash route contract shared by all three prototypes, so the same surfaces can
 * be screenshotted side by side. Not a router: one string in, one string out.
 */
export function routeOf(state: State): string {
  switch (state.page.kind) {
    case "settings":
      return `#/settings/${state.page.section}`;
    case "routines":
      return state.page.routineId ? `#/routines/${state.page.routineId}` : "#/routines";
    case "search":
      return "#/search";
    case "none":
      break;
  }
  const tabs = state.tabsByWorkspace[state.workspaceId];
  const tab = tabs?.tabs.find((t) => t.id === tabs.activeId);
  if (tab?.kind === "session") return `#/session/${tab.sessionId}`;
  if (tab?.kind === "file") return `#/file/${tab.relative}`;
  if (tab?.kind === "stub") return `#/stub/${tab.stub}`;
  return "#/";
}

const DEFAULT_SESSION = "s-harness";

/** Unknown routes and routes naming things that are gone both land on the default. */
export function applyRoute(hash: string): void {
  const path = hash.replace(/^#/, "");
  const parts = path.split("/").filter(Boolean);
  const [head, ...rest] = parts;

  if (head === "session") {
    const id = rest.join("/");
    if (store.state.sessions.some((s) => s.id === id)) {
      store.openSession(id);
      return;
    }
  }
  if (head === "file") {
    const relative = rest.join("/");
    if (store.state.files.some((file) => file.relative === relative)) {
      store.openFile(relative);
      return;
    }
  }
  if (head === "search") {
    store.openSearch(rest.join("/"));
    return;
  }
  if (head === "routines") {
    const id = rest[0];
    if (!id) {
      store.openRoutines(null);
      return;
    }
    if (store.state.routines.some((r) => r.id === id)) {
      store.openRoutines(id);
      return;
    }
    store.openRoutines(null);
    return;
  }
  if (head === "settings") {
    const section = rest[0] as SettingsSectionId | undefined;
    store.openSettings(
      section && SETTINGS_SECTIONS.some((s) => s.id === section) ? section : "general",
    );
    return;
  }
  if (head === "stub" && rest[0]) {
    const stub = rest[0];
    if (stub === "terminal" || stub === "browser" || stub === "sidechat") {
      store.openStub(stub, stub === "sidechat" ? "Side chat" : stub);
      return;
    }
  }
  store.openSession(DEFAULT_SESSION);
}

export function useHashRoute(): void {
  const state = useApp();
  const booted = useRef(false);

  useEffect(() => {
    // Nothing can be opened before the data source has answered.
    if (booted.current || !state.ready) return;
    booted.current = true;
    applyRoute(window.location.hash);
    const onHash = () => {
      if (window.location.hash !== routeOf(store.state)) applyRoute(window.location.hash);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [state.ready]);

  useEffect(() => {
    if (!booted.current) return;
    const next = routeOf(state);
    if (window.location.hash !== next) {
      window.history.replaceState(null, "", next);
    }
  }, [state]);
}
