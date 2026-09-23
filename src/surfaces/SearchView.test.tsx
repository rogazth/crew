// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../lib/protocol";
import type { Session } from "../lib/types";
import { click, dispatch, mount, type Mounted, type } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { SearchView } from "./SearchView";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime();
const AGENTS = [{ id: "a1", name: "Ada", kind: "agent" } as Session];

function hit(sessionId: string, sessionName: string, pos: number): SearchHit {
  return { sessionId, sessionName, pos, id: `b${pos}`, role: "assistant", at: NOW, snippet: `found in ${sessionName}` };
}

let view: Mounted;
let onOpenHit: ReturnType<typeof vi.fn<(sessionId: string, pos: number) => void>>;

function field(): HTMLInputElement {
  return view.container.querySelector<HTMLInputElement>('input[aria-label="Search messages"]')!;
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

async function answer(request: { resolve(value: unknown): void }, hits: SearchHit[]) {
  await act(async () => request.resolve(hits));
}

/**
 * Picks an option in a kumo (base-ui) Select. It opens on click and commits on
 * the pointer's release; the popup then closes over a few ticks of its own.
 */
async function choose(label: string, option: string) {
  click(view.container.querySelector(`[aria-label="${label}"]`)!);
  const target = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent?.includes(option))!;
  for (const name of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" };
    dispatch(target, name.startsWith("pointer") ? new PointerEvent(name, init) : new MouseEvent(name, init));
  }
  click(target);
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

/** The result rows, found by the agent name each one carries. */
function row(name: string): HTMLButtonElement | undefined {
  return [...view.container.querySelectorAll("button")].find((button) => button.textContent?.startsWith(name));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake.reset();
  onOpenHit = vi.fn();
  view = mount(<SearchView agents={AGENTS} onOpenHit={onOpenHit} />);
});

afterEach(() => {
  view.unmount();
  vi.useRealTimers();
});

describe("SearchView", () => {
  it("sends nothing for an empty or blank query", () => {
    type(field(), "   ");
    wait(500);
    expect(fake.sent("messages_search")).toEqual([]);
  });

  it("asks once the typing pauses, with the query trimmed", () => {
    type(field(), "  needle ");
    wait(119);
    expect(fake.sent("messages_search")).toEqual([]);
    wait(1);
    expect(fake.sent("messages_search")).toEqual([
      { query: "needle", sessionIds: [], sort: "relevance", limit: 101 },
    ]);
  });

  it("sends only the last of several quick edits", () => {
    type(field(), "ne");
    wait(60);
    type(field(), "nee");
    wait(60);
    type(field(), "needle");
    wait(120);
    expect(fake.sent("messages_search").map((query) => query.query)).toEqual(["needle"]);
  });

  it("sends nothing when the page closes mid-debounce", () => {
    type(field(), "needle");
    view.unmount();
    wait(500);
    expect(fake.sent("messages_search")).toEqual([]);
    view = mount(<SearchView agents={AGENTS} onOpenHit={onOpenHit} />);
  });

  it("opens the agent at the line a hit points to", async () => {
    type(field(), "needle");
    wait(120);
    await answer(fake.take("messages_search"), [hit("a1", "Ada", 7)]);
    click(row("Ada")!);
    expect(onOpenHit).toHaveBeenCalledWith("a1", 7);
  });

  it("keeps the newest query's answer when an older one lands late", async () => {
    type(field(), "nee");
    wait(120);
    const older = fake.take("messages_search");
    type(field(), "needle");
    wait(120);
    await answer(fake.take("messages_search"), [hit("a1", "Newer", 2)]);
    await answer(older, [hit("a1", "Older", 1)]);
    expect(row("Older")).toBeUndefined();
    click(row("Newer")!);
    expect(onOpenHit).toHaveBeenCalledWith("a1", 2);
  });

  it("ignores an older query's failure once a newer one answered", async () => {
    type(field(), "nee");
    wait(120);
    const older = fake.take("messages_search");
    type(field(), "needle");
    wait(120);
    await answer(fake.take("messages_search"), [hit("a1", "Newer", 2)]);
    await act(async () => older.reject(new Error("index is locked")));
    expect(view.container.textContent).not.toContain("index is locked");
    expect(row("Newer")).toBeDefined();
  });

  it("shows why a search failed and drops the previous hits", async () => {
    type(field(), "nee");
    wait(120);
    await answer(fake.take("messages_search"), [hit("a1", "Ada", 1)]);
    type(field(), "needle");
    wait(120);
    await act(async () => fake.take("messages_search").reject(new Error("index is locked")));
    expect(view.container.textContent).toContain("index is locked");
    expect(row("Ada")).toBeUndefined();
  });

  it("clears the error once the next query answers", async () => {
    type(field(), "nee");
    wait(120);
    await act(async () => fake.take("messages_search").reject(new Error("index is locked")));
    type(field(), "needle");
    wait(120);
    await answer(fake.take("messages_search"), [hit("a1", "Ada", 1)]);
    expect(view.container.textContent).not.toContain("index is locked");
  });

  it("stops showing hits when the box is emptied, without asking again", async () => {
    type(field(), "needle");
    wait(120);
    await answer(fake.take("messages_search"), [hit("a1", "Ada", 1)]);
    type(field(), "");
    wait(500);
    expect(row("Ada")).toBeUndefined();
    expect(fake.sent("messages_search")).toHaveLength(1);
  });
  it("limits the search to the range picked", () => {
    const today = [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Today")!;
    click(today);
    type(field(), "needle");
    wait(120);
    expect(fake.sent("messages_search")[0]).toMatchObject({ from: new Date(2026, 8, 23).getTime() });
  });

  it("sorts by newest when asked", () => {
    const newest = [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Newest")!;
    click(newest);
    type(field(), "needle");
    wait(120);
    expect(fake.sent("messages_search")[0]).toMatchObject({ sort: "newest" });
  });
  it("narrows the search to the agent picked", async () => {
    await choose("Agent", "Ada");
    type(field(), "needle");
    wait(120);
    expect(fake.sent("messages_search")[0]).toMatchObject({ sessionIds: ["a1"] });
  });
});
