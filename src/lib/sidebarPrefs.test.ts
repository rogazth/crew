import { describe, expect, it } from "vitest";
import { arrangeSessions, DEFAULT_PREFS, parsePrefs } from "./sidebarPrefs";
import type { Session } from "./types";

const session = (id: string, kind: Session["kind"], updatedAt: number, provider = "claude") =>
  ({ id, kind, name: id, provider, model: "", updatedAt }) as Session;

describe("parsePrefs", () => {
  it("drops what older builds stored and keeps what still means something", () => {
    const raw = JSON.stringify({ grouping: "status", ordering: "manual", show: ["avatar", "status"] });
    expect(parsePrefs(raw)).toEqual({ ...DEFAULT_PREFS, ordering: "manual", show: ["status"] });
  });

  it("falls back to the defaults on garbage", () => {
    expect(parsePrefs("{")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(null).ordering).toBe("updated");
  });
});

describe("arrangeSessions", () => {
  const list = [session("a", "agent", 1), session("t", "terminal", 3), session("b", "agent", 2, "codex")];

  it("splits by kind, newest first", () => {
    const { agents, terminals } = arrangeSessions(list, DEFAULT_PREFS, "");
    expect(agents.map((s) => s.id)).toEqual(["b", "a"]);
    expect(terminals.map((s) => s.id)).toEqual(["t"]);
  });

  it("hides filtered kinds and providers", () => {
    const prefs = { ...DEFAULT_PREFS, hiddenKinds: ["terminal" as const], hiddenProviders: ["codex"] };
    const { agents, terminals } = arrangeSessions(list, prefs, "");
    expect(agents.map((s) => s.id)).toEqual(["a"]);
    expect(terminals).toEqual([]);
  });
});
