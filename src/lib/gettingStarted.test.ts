import { describe, expect, it } from "vitest";
import { parseTour, tourSteps } from "./gettingStarted";
import type { Session, Workspace } from "./types";

const home: Workspace = { id: "h", name: "Home", path: "/Users/me/Crew", createdAt: 0, home: true };
const project: Workspace = { id: "p", name: "crew", path: "/Users/me/crew", createdAt: 0 };
const session = (workspaceId: string, kind: Session["kind"]) => ({ id: `${workspaceId}-${kind}`, workspaceId, kind }) as Session;
const done = (steps: ReturnType<typeof tourSteps>) => steps.filter((step) => step.done).map((step) => step.id);

describe("tourSteps", () => {
  it("starts with nothing done", () => {
    expect(done(tourSteps(home, [], [], parseTour(null)))).toEqual([]);
  });

  it("reads each step off what is there", () => {
    const sessions = [session("h", "terminal"), session("p", "bot")];
    expect(done(tourSteps(home, [project], sessions, { browser: true, dismissed: false }))).toEqual(["ask", "folder", "bot", "browser"]);
  });

  it("counts only a session in home as asking", () => {
    expect(done(tourSteps(home, [project], [session("p", "terminal")], parseTour(null)))).toEqual(["folder"]);
  });

  it("reads a broken memory as an empty one", () => {
    expect(parseTour("{")).toEqual({ browser: false, dismissed: false });
  });
});
