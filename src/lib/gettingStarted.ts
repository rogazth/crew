import type { Session, Workspace } from "./types";

export type StepId = "ask" | "folder" | "agent" | "browser";
export type Step = { id: StepId; label: string; done: boolean };

/** What the window remembers about the tour: a page was opened once, or the tour was put away. */
export type TourMemory = { browser: boolean; dismissed: boolean };

export const TOUR_KEY = "getting_started";

export function parseTour(raw: string | null): TourMemory {
  try {
    const parsed = JSON.parse(raw ?? "{}") as Partial<TourMemory>;
    return { browser: parsed.browser === true, dismissed: parsed.dismissed === true };
  } catch {
    return { browser: false, dismissed: false };
  }
}

/**
 * Home's tour, read off what is already there rather than kept as its own
 * checklist: a session in home, a project, an agent anywhere, a page opened.
 */
export function tourSteps(home: Workspace | null, projects: Workspace[], sessions: Session[], memory: TourMemory): Step[] {
  return [
    { id: "ask", label: "Ask anything", done: home !== null && sessions.some((s) => s.workspaceId === home.id) },
    { id: "folder", label: "Open a project folder", done: projects.length > 0 },
    { id: "agent", label: "Meet your first agent", done: sessions.some((s) => s.kind === "agent") },
    { id: "browser", label: "Drive a browser tab", done: memory.browser },
  ];
}
