import { describe, expect, it } from "vitest";
import type { Session, Workspace } from "./types";
import {
  filterSessions,
  filterWorkspaces,
  nameFromPath,
  nextSessionName,
  resolveActive,
  shortenPath,
  workspaceMark,
} from "./workspaces";

const workspace = (id: string, name: string, path = `/Users/me/code/${name}`): Workspace => ({ id, name, path, createdAt: 0 });

const session = (name: string, over: Partial<Session> = {}): Session => ({
  id: name,
  workspaceId: "w1",
  kind: "terminal",
  name,
  provider: "claude",
  model: "",
  providerSessionId: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("nameFromPath", () => {
  it("proposes the last path segment", () => {
    expect(nameFromPath("/Users/me/code/furry")).toBe("furry");
    expect(nameFromPath("/Users/me/code/furry///")).toBe("furry");
    expect(nameFromPath("furry")).toBe("furry");
  });

  it("proposes nothing for the root or an empty path", () => {
    expect(nameFromPath("/")).toBe("");
    expect(nameFromPath("")).toBe("");
  });
});

describe("resolveActive", () => {
  const list = [workspace("w1", "crew"), workspace("w2", "api")];

  it("finds the active workspace by id", () => {
    expect(resolveActive(list, "w2")).toBe(list[1]);
  });

  it("falls back to the first workspace when the id is missing or stale", () => {
    expect(resolveActive(list, null)).toBe(list[0]);
    expect(resolveActive(list, "gone")).toBe(list[0]);
  });

  it("is null with no workspaces", () => {
    expect(resolveActive([], "w1")).toBeNull();
  });
});

describe("filterWorkspaces", () => {
  const crew = workspace("w1", "crew", "/Users/me/code/crew");
  const api = workspace("w2", "storefront-api", "/Users/me/work/shop");
  const shop = workspace("w3", "billing", "/Users/me/crew-tools/billing");

  it("returns the list untouched for a blank query", () => {
    const list = [crew, api];
    expect(filterWorkspaces(list, "")).toBe(list);
    expect(filterWorkspaces(list, "   ")).toBe(list);
  });

  it("keeps only workspaces whose name or path matches", () => {
    expect(filterWorkspaces([crew, api, shop], "shop")).toEqual([api]);
    expect(filterWorkspaces([crew, api, shop], "zzz")).toEqual([]);
  });

  it("ranks a name match above a path match", () => {
    expect(filterWorkspaces([shop, crew], "crew")).toEqual([crew, shop]);
  });
});

describe("filterSessions", () => {
  it("returns the list untouched for a blank query", () => {
    const list = [session("claude")];
    expect(filterSessions(list, " ")).toBe(list);
  });

  it("matches the provider and model line when the name does not", () => {
    const opus = session("fix tests", { model: "claude-opus-5" });
    const codex = session("refactor", { provider: "codex", model: "gpt-5.5" });
    expect(filterSessions([opus, codex], "opus")).toEqual([opus]);
    expect(filterSessions([opus, codex], "codex")).toEqual([codex]);
  });

  it("ranks a name match above a provider match", () => {
    const byProvider = session("fix tests", { provider: "codex" });
    const byName = session("codex notes", { provider: "claude" });
    expect(filterSessions([byProvider, byName], "codex")).toEqual([byName, byProvider]);
  });

  it("drops sessions that match nothing", () => {
    expect(filterSessions([session("claude")], "zzz")).toEqual([]);
  });
});

describe("nextSessionName", () => {
  it("uses the base name while it is free", () => {
    expect(nextSessionName([], "claude")).toBe("claude");
    expect(nextSessionName([session("codex")], "claude")).toBe("claude");
  });

  it("numbers from 2 and fills the first gap", () => {
    expect(nextSessionName([session("claude")], "claude")).toBe("claude 2");
    expect(nextSessionName([session("claude"), session("claude 2")], "claude")).toBe("claude 3");
    expect(nextSessionName([session("claude"), session("claude 3")], "claude")).toBe("claude 2");
  });

  it("counts only terminal sessions as taken", () => {
    expect(nextSessionName([session("claude", { kind: "agent" })], "claude")).toBe("claude");
  });
});

describe("shortenPath", () => {
  it("replaces the home prefix with ~", () => {
    expect(shortenPath("/Users/me/code/crew")).toBe("~/code/crew");
    expect(shortenPath("/home/me/code")).toBe("~/code");
    expect(shortenPath("/Users/me")).toBe("~");
  });

  it("leaves other paths alone", () => {
    expect(shortenPath("/opt/code")).toBe("/opt/code");
    expect(shortenPath("/Users")).toBe("/Users");
    expect(shortenPath("/srv/home/me/x")).toBe("/srv/home/me/x");
  });
});

describe("workspaceMark", () => {
  it("takes up to two initials from the folder name", () => {
    expect(workspaceMark("storefront-api")).toBe("SA");
    expect(workspaceMark("crew")).toBe("C");
    expect(workspaceMark("my cool app")).toBe("MC");
    expect(workspaceMark("a.b_c")).toBe("AB");
  });

  it("falls back to ? when there is nothing to take", () => {
    expect(workspaceMark("")).toBe("?");
    expect(workspaceMark("--_")).toBe("?");
  });
});
