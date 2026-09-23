import { describe, expect, it } from "vitest";
import { commandKeys } from "./commands";
import { IS_MAC } from "./hotkey";
import { DELETE, EDIT, RENAME } from "./menu";
import {
  actsOnSelection,
  clickModifiers,
  groupAdd,
  rowKeyAction,
  rowMenuActions,
} from "./sessionSidebar";
import type { SessionGroup } from "./sidebarPrefs";
import type { Session } from "./types";

function session(id: string, kind: Session["kind"] = "agent"): Session {
  return {
    id,
    workspaceId: "w1",
    kind,
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
  };
}

const group = (kind: SessionGroup["kind"]): SessionGroup => ({ id: "g", label: "G", kind, sessions: [] });
const chord = IS_MAC ? { key: "Backspace", metaKey: true } : { key: "Delete", metaKey: false };
const key = (value: string) => ({ key: value, metaKey: false });

describe("clickModifiers", () => {
  const none = { metaKey: false, ctrlKey: false, shiftKey: false };

  it("toggles with ⌘ on macOS, not Ctrl", () => {
    expect(clickModifiers({ ...none, metaKey: true }, true)).toEqual({ toggle: true, range: false });
    expect(clickModifiers({ ...none, ctrlKey: true }, true)).toEqual({ toggle: false, range: false });
  });

  it("toggles with Ctrl elsewhere, not the meta key", () => {
    expect(clickModifiers({ ...none, ctrlKey: true }, false)).toEqual({ toggle: true, range: false });
    expect(clickModifiers({ ...none, metaKey: true }, false)).toEqual({ toggle: false, range: false });
  });

  it("extends the range with Shift on every platform", () => {
    expect(clickModifiers({ ...none, shiftKey: true }, true)).toEqual({ toggle: false, range: true });
    expect(clickModifiers({ ...none, shiftKey: true }, false)).toEqual({ toggle: false, range: true });
  });

  it("reads the running platform by default", () => {
    const toggleKey = IS_MAC ? { metaKey: true } : { ctrlKey: true };
    expect(clickModifiers({ ...none, ...toggleKey })).toEqual({ toggle: true, range: false });
  });
});

describe("groupAdd", () => {
  it("adds an agent to the agents group and a session to the sessions group", () => {
    expect(groupAdd(group("agent"))).toEqual({ command: "new-agent", hint: `New agent ${commandKeys("new-agent")}` });
    expect(groupAdd(group("terminal"))).toEqual({
      command: "new-session",
      hint: `New session ${commandKeys("new-session")}`,
    });
  });

  it("offers no add for a group of mixed kinds", () => {
    expect(groupAdd(group(null))).toBeNull();
  });
});

describe("actsOnSelection", () => {
  it("acts for the selection when the row is one of several selected", () => {
    expect(actsOnSelection(session("a"), new Set(["a", "b"]))).toBe(true);
  });

  it("acts alone for a row outside the selection", () => {
    expect(actsOnSelection(session("c"), new Set(["a", "b"]))).toBe(false);
  });

  it("acts alone when the row is the only one selected", () => {
    expect(actsOnSelection(session("a"), new Set(["a"]))).toBe(false);
  });
});

describe("rowMenuActions", () => {
  it("offers edit and delete for an agent", () => {
    expect(rowMenuActions(session("a", "agent"), new Set(["a"]))).toEqual([EDIT, DELETE]);
  });

  it("offers rename and delete for a terminal", () => {
    expect(rowMenuActions(session("t", "terminal"), new Set())).toEqual([RENAME, DELETE]);
  });

  it("offers one delete, counted, for a multi-selection", () => {
    const actions = rowMenuActions(session("a"), new Set(["a", "b", "c"]));
    expect(actions).toEqual([{ ...DELETE, label: "Delete 3 items" }]);
  });

  it("ignores a multi-selection the row is not part of", () => {
    expect(rowMenuActions(session("t", "terminal"), new Set(["a", "b"]))).toEqual([RENAME, DELETE]);
  });
});

describe("rowKeyAction", () => {
  it("renames on F2 only where renaming is offered", () => {
    expect(rowKeyAction(key("F2"), true)).toBe("rename");
    expect(rowKeyAction(key("F2"), false)).toBeNull();
  });

  it("clears the selection on Escape", () => {
    expect(rowKeyAction(key("Escape"), false)).toBe("clear");
  });

  it("removes on the platform's delete chord", () => {
    expect(rowKeyAction(chord, false)).toBe("remove");
  });

  it("ignores other keys", () => {
    expect(rowKeyAction(key("Enter"), true)).toBeNull();
    expect(rowKeyAction(key("a"), true)).toBeNull();
  });
});
