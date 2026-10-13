import { describe, expect, it } from "vitest";
import { requestAgent, routeAgent, takeAgentRequest } from "./agentRoute";
import type { Session } from "./types";

const row = (id: string, extra: Partial<Session> = {}) => ({ id, kind: "bot", ...extra }) as unknown as Session;
const child = (id: string, parentId: string, extra: Partial<Session> = {}) => row(id, { kind: "child", parentId, ...extra });

describe("routeAgent", () => {
  it("keeps an independent session in its own tab", () => {
    expect(routeAgent(row("a"), [row("a")])).toBeNull();
  });
  it("sends an owned subagent to its parent", () => {
    const all = [row("p"), child("c", "p")];
    const route = routeAgent(all[1]!, all)!;
    expect(route.root.id).toBe("p");
    expect(route.links).toEqual([{ parentId: "p", childId: "c" }]);
  });
  it("climbs to the top of nested owners", () => {
    const all = [row("p"), child("c", "p"), child("g", "c")];
    const route = routeAgent(all[2]!, all)!;
    expect(route.root.id).toBe("p");
    expect(route.links.map((l) => l.childId)).toEqual(["c", "g"]);
  });
  it("keeps a launched session, or one whose parent is gone, in its own tab", () => {
    const launched = child("c", "p", { launchedBy: "p" });
    expect(routeAgent(launched, [row("p"), launched])).toBeNull();
    expect(routeAgent(child("c", "gone"), [child("c", "gone")])).toBeNull();
  });
});

describe("requests", () => {
  it("are taken once", () => {
    requestAgent("p", { childId: "c" });
    expect(takeAgentRequest("p")).toEqual({ childId: "c" });
    expect(takeAgentRequest("p")).toBeUndefined();
  });
});
