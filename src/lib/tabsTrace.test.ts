import { describe, expect, it } from "vitest";
import { tabEvents } from "./tabsTrace";
import type { TabRegistry, TabState } from "./tabs";
import type { Tab } from "./types";

const session: Tab = { id: "session:s1", kind: "session", sessionId: "s1" };
const page: Tab = { id: "browser:1", kind: "browser", url: "https://private.example/secret?token=abc", title: "Private title" };
const file: Tab = { id: "file:/Users/me/secret/plan.md", kind: "file", path: "/Users/me/secret/plan.md", relative: "secret/plan.md" };
const terminal: Tab = { id: "stub:terminal:1", kind: "stub", stub: "terminal", title: "Terminal" };

const state = (tabs: Tab[], activeId: string | null): TabState => ({ tabs, activeId, closed: [] });
const registry = (...entries: Array<[string, TabState]>): TabRegistry => Object.fromEntries(entries);

describe("tab events", () => {
  it("says a tab opened in front by its opening alone", () => {
    const events = tabEvents(registry(["w1", state([session], session.id)]), registry(["w1", state([session, terminal], terminal.id)]));
    expect(events).toEqual([{ message: "tab.open", fields: { workspace: "w1", kind: "stub", stub: "terminal", tabs: 2 } }]);
  });

  it("says a switch and a close, with a session's id and nothing of a page or a file", () => {
    const before = registry(["w1", state([session, page, file], session.id)]);
    const switched = tabEvents(before, registry(["w1", state([session, page, file], page.id)]));
    expect(switched).toEqual([{ message: "tab.switch", fields: { workspace: "w1", kind: "browser", tabs: 3 } }]);
    const closed = tabEvents(before, registry(["w1", state([session], session.id)]));
    expect(closed.map((event) => [event.message, event.fields.kind])).toEqual([
      ["tab.close", "browser"],
      ["tab.close", "file"],
    ]);
    const everything = JSON.stringify([switched, closed, tabEvents(registry(["w1", state([], null)]), before)]);
    expect(everything).not.toMatch(/private|secret|plan\.md|Private title|token/);
    expect(tabEvents(registry(["w1", state([], null)]), registry(["w1", state([session], session.id)]))[0]?.fields).toMatchObject({ session: "s1" });
  });

  it("says nothing of a workspace that is only being restored, or of a registry that did not change", () => {
    const restored = registry(["w2", state([session, page], session.id)]);
    expect(tabEvents({}, restored)).toEqual([]);
    expect(tabEvents(restored, restored)).toEqual([]);
    expect(tabEvents(restored, { ...restored })).toEqual([]);
  });
});
