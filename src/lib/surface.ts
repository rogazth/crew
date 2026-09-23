import type { Session, StubKind, Tab } from "./types";

/** What fills the pane for the active tab. Agents and terminals live in overlays, so they fill nothing here. */
export type SurfaceRoute =
  | { kind: "no-workspace" }
  | { kind: "no-tab" }
  | { kind: "stub"; stub: StubKind; title: string }
  | { kind: "file"; path: string; relative: string }
  | { kind: "missing-session" }
  | { kind: "overlay" };

export function surfaceRoute(tab: Tab | null, sessions: Session[], hasWorkspace: boolean): SurfaceRoute {
  if (!hasWorkspace) return { kind: "no-workspace" };
  if (!tab) return { kind: "no-tab" };
  if (tab.kind === "stub") {
    return tab.stub === "terminal" ? { kind: "overlay" } : { kind: "stub", stub: tab.stub, title: tab.title };
  }
  if (tab.kind === "file") return { kind: "file", path: tab.path, relative: tab.relative };
  const session = sessions.find((s) => s.id === tab.sessionId);
  return session ? { kind: "overlay" } : { kind: "missing-session" };
}

export function agentsOf(sessions: Session[]): Session[] {
  return sessions.filter((session) => session.kind === "agent");
}
