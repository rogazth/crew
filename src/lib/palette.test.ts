import { describe, expect, it } from "vitest";
import {
  FILE_LIMIT,
  groupStarts,
  itemFace,
  paletteActions,
  paletteGroups,
  rankItems,
  readQuery,
  searchText,
  stepMode,
  type PaletteItem,
} from "./palette";
import type { ProjectFile, Session, Workspace } from "./types";

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: "w1",
    kind: "agent",
    name: id,
    provider: "claude",
    model: "",
    providerSessionId: null,
    description: "",
    notifications: true,
    autonomy: "ask",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function file(relative: string): ProjectFile {
  const name = relative.split("/").pop()!;
  return { name, path: `/repo/${relative}`, relative };
}

function workspace(id: string, name = id): Workspace {
  return { id, name, path: `/code/${name}`, createdAt: 0 };
}

const action = (id: "new-agent" | "new-session" | "open-settings" | "toggle-sidebar" | "save-file" | "reopen-tab", label: string): PaletteItem => ({
  key: `action:${id}`,
  kind: "action",
  id,
  label,
  keys: "",
});

const keys = (items: PaletteItem[]) => items.map((item) => item.key);
const shape = (groups: { label: string; items: PaletteItem[] }[]) =>
  groups.map((group) => [group.label, keys(group.items)]);

describe("readQuery", () => {
  it("searches the chosen filter with the raw text", () => {
    expect(readQuery("abc", "files")).toEqual({ query: "abc", shown: "files" });
  });

  it("shows actions for a leading > and drops it from the query", () => {
    expect(readQuery(">new", "files")).toEqual({ query: "new", shown: "actions" });
    expect(readQuery(">", "all")).toEqual({ query: "", shown: "actions" });
  });

  it("treats a > later in the text as part of the query", () => {
    expect(readQuery("a>b", "all")).toEqual({ query: "a>b", shown: "all" });
  });
});

describe("stepMode", () => {
  it("moves forward and back through the filters", () => {
    expect(stepMode("all", 1)).toBe("agents");
    expect(stepMode("files", -1)).toBe("sessions");
  });

  it("wraps at both ends", () => {
    expect(stepMode("actions", 1)).toBe("all");
    expect(stepMode("all", -1)).toBe("actions");
  });
});

describe("paletteActions", () => {
  it("lists commands first, then a switch to every other workspace", () => {
    const items = paletteActions(
      [{ id: "new-agent", label: "New Agent", keys: "⇧⌘N" }],
      [workspace("w1"), workspace("w2"), workspace("w3")],
      "w2",
    );
    expect(keys(items)).toEqual(["action:new-agent", "ws:w1", "ws:w3"]);
    expect(items[0]).toEqual({ key: "action:new-agent", kind: "action", id: "new-agent", label: "New Agent", keys: "⇧⌘N" });
  });

  it("offers no switch when the only workspace is the active one", () => {
    expect(paletteActions([], [workspace("w1")], "w1")).toEqual([]);
  });
});

describe("paletteGroups", () => {
  const sessions = [
    session("alpha", { kind: "agent", updatedAt: 1 }),
    session("beta", { kind: "terminal", updatedAt: 7 }),
    session("gamma", { kind: "agent", updatedAt: 3 }),
    session("delta", { kind: "terminal", updatedAt: 9 }),
    session("epsilon", { kind: "agent", updatedAt: 5 }),
    session("zeta", { kind: "terminal", updatedAt: 2 }),
  ];
  const files = [file("src/app.ts"), file("src/lib/beta.ts"), file("README.md")];
  const actions = [
    action("new-agent", "New Agent"),
    action("new-session", "New Session"),
    action("open-settings", "Settings"),
    action("toggle-sidebar", "Toggle Sidebar"),
    action("save-file", "Save File"),
    action("reopen-tab", "Reopen Closed Tab"),
  ];
  const base = { sessions, files, actions };

  it("opens All on the five most recent sessions and the first five actions", () => {
    const groups = paletteGroups({ ...base, shown: "all", query: "" });
    expect(shape(groups)).toEqual([
      ["Recent", ["session:delta", "session:beta", "session:epsilon", "session:gamma", "session:zeta"]],
      ["Actions", keys(actions.slice(0, 5))],
    ]);
  });

  it("treats a blank query in All as the cold open", () => {
    const groups = paletteGroups({ ...base, shown: "all", query: "   " });
    expect(groups.map((group) => group.label)).toEqual(["Recent", "Actions"]);
  });

  it("sorts Recent without reordering the sessions it was given", () => {
    const before = sessions.map((s) => s.id);
    paletteGroups({ ...base, shown: "all", query: "" });
    expect(sessions.map((s) => s.id)).toEqual(before);
  });

  it("searches every kind in All, in a fixed group order", () => {
    const groups = paletteGroups({ ...base, shown: "all", query: "beta" });
    expect(shape(groups)).toEqual([
      ["Agents", []],
      ["Sessions", ["session:beta"]],
      ["Files", ["file:/repo/src/lib/beta.ts"]],
      ["Actions", []],
    ]);
  });

  it("caps files at ten in All", () => {
    const many = Array.from({ length: 15 }, (_, i) => file(`src/file${i}.ts`));
    const groups = paletteGroups({ ...base, files: many, shown: "all", query: "file" });
    expect(groups.find((group) => group.label === "Files")!.items).toHaveLength(10);
  });

  it("keeps the Agents filter to agents", () => {
    const groups = paletteGroups({ ...base, shown: "agents", query: "" });
    expect(shape(groups)).toEqual([["Agents", ["session:alpha", "session:gamma", "session:epsilon"]]]);
  });

  it("keeps the Sessions filter to terminals, ranked by the query", () => {
    const groups = paletteGroups({ ...base, shown: "sessions", query: "ta" });
    expect(groups[0]!.label).toBe("Sessions");
    expect(keys(groups[0]!.items).sort()).toEqual(["session:beta", "session:delta", "session:zeta"]);
  });

  it("ranks actions under the Actions filter", () => {
    const groups = paletteGroups({ ...base, shown: "actions", query: "new ses" });
    expect(shape(groups)).toEqual([["Actions", ["action:new-session"]]]);
  });

  it("caps the Files filter at the file limit", () => {
    const many = Array.from({ length: FILE_LIMIT + 5 }, (_, i) => file(`f${i}.ts`));
    const groups = paletteGroups({ ...base, files: many, shown: "files", query: "" });
    expect(groups[0]!.label).toBe("Files");
    expect(groups[0]!.items).toHaveLength(FILE_LIMIT);
    expect(groups[0]!.items[0]).toEqual({ key: "file:/repo/f0.ts", kind: "file", file: many[0] });
  });
});

describe("groupStarts", () => {
  it("places each group after the rows of the ones above it, empty groups included", () => {
    const a = action("save-file", "Save File");
    const groups = [
      { label: "Agents", items: [a, a] },
      { label: "Sessions", items: [] },
      { label: "Files", items: [a] },
      { label: "Actions", items: [a] },
    ];
    expect(groupStarts(groups)).toEqual([0, 2, 2, 3]);
  });

  it("has no starts without groups", () => {
    expect(groupStarts([])).toEqual([]);
  });
});

describe("rankItems", () => {
  const items = [action("toggle-sidebar", "Toggle Sidebar"), action("save-file", "Save File"), action("new-session", "New Session")];

  it("keeps the input order for an empty or blank query", () => {
    expect(rankItems(items, "")).toBe(items);
    expect(rankItems(items, "  ")).toBe(items);
  });

  it("drops items that do not match", () => {
    expect(keys(rankItems(items, "xyz"))).toEqual([]);
  });

  it("puts the best match first", () => {
    // "s" starts a word in all three; the shorter the label, the higher it scores.
    expect(keys(rankItems(items, "s"))).toEqual(["action:save-file", "action:new-session", "action:toggle-sidebar"]);
  });
});

describe("searchText", () => {
  it("searches a file by its relative path, not just its name", () => {
    expect(searchText({ key: "f", kind: "file", file: file("src/lib/x.ts") })).toBe("src/lib/x.ts");
  });

  it("searches sessions and workspaces by name, and actions by label", () => {
    expect(searchText({ key: "s", kind: "session", session: session("s", { name: "Research" }) })).toBe("Research");
    expect(searchText({ key: "w", kind: "workspace", workspace: workspace("w", "crew") })).toBe("crew");
    expect(searchText(action("save-file", "Save File"))).toBe("Save File");
  });
});

describe("itemFace", () => {
  it("labels a file by name, with its path as the detail", () => {
    expect(itemFace({ key: "f", kind: "file", file: file("src/a.ts") })).toEqual({ label: "a.ts", detail: "src/a.ts" });
  });

  it("labels a session by name, with its provider as the detail", () => {
    const face = itemFace({ key: "s", kind: "session", session: session("s", { name: "Docs", provider: "codex" }) });
    expect(face).toEqual({ label: "Docs", detail: "codex" });
  });

  it("labels a workspace as a switch, with its path as the detail", () => {
    expect(itemFace({ key: "w", kind: "workspace", workspace: workspace("w", "crew") })).toEqual({
      label: "Switch to crew",
      detail: "/code/crew",
    });
  });

  it("labels an action with no detail", () => {
    expect(itemFace(action("save-file", "Save File"))).toEqual({ label: "Save File" });
  });
});
