// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/blocks";
import { click, dispatch, mount, only, type Mounted } from "../../test/dom";
import { act } from "../../test/renderHook";
import { Transcript } from "./Transcript";

vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});

/** Observers the test fires by hand: happy-dom lays nothing out. */
class Observer {
  static all: Observer[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void,
    readonly options?: unknown,
  ) {
    Observer.all.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}
  fire(isIntersecting = true) {
    act(() => this.callback([{ isIntersecting }]));
  }
}
class Intersections extends Observer {}
class Resizes extends Observer {}

const user = (id: string, text = id): Block => ({ id, role: "user", text });

let view: Mounted | null = null;
const onLoadEarlier = vi.fn();
const noop = () => undefined;

type Options = { blocks?: Block[]; more?: boolean; loadingEarlier?: boolean; focusId?: string | null; active?: boolean };

function tree({ blocks = [user("u1")], more = false, loadingEarlier = false, focusId = null, active = true }: Options) {
  return (
    <Transcript
      blocks={blocks}
      working={false}
      active={active}
      more={more}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={onLoadEarlier}
      focusId={focusId}
      onApprove={noop}
      onAnswer={noop}
    />
  );
}

function render(options: Options = {}) {
  view = mount(tree(options));
  return only<HTMLDivElement>(view.container, '[data-selectable="blocks"]');
}

/** Gives the scroller a box, since happy-dom has no layout. */
function size(el: HTMLElement, box: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
}

function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  dispatch(el, new Event("scroll"));
}

const intersections = () => Observer.all.filter((o) => o instanceof Intersections);
const resizes = () => Observer.all.filter((o) => o instanceof Resizes);

beforeEach(() => {
  Observer.all = [];
  onLoadEarlier.mockClear();
  vi.stubGlobal("IntersectionObserver", Intersections);
  vi.stubGlobal("ResizeObserver", Resizes);
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("earlier messages", () => {
  it("loads the page before from the button, which waits while it loads", () => {
    render({ more: true });
    const button = [...view!.container.querySelectorAll("button")].find((b) => b.textContent === "Earlier messages")!;
    click(button);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    view!.rerender(tree({ more: true, loadingEarlier: true }));
    expect(button.disabled).toBe(true);
  });

  it("fetches as the reader nears the top", () => {
    render({ more: true });
    const [observer] = intersections();
    observer!.fire(false);
    expect(onLoadEarlier).not.toHaveBeenCalled();
    observer!.fire(true);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("watches nothing once the start is reached", () => {
    render({ more: true });
    view!.rerender(tree({ more: false }));
    expect(intersections()[0]!.disconnected).toBe(true);
    expect(intersections()).toHaveLength(1);
  });

  it("never watches a transcript that starts at its first message", () => {
    render({ more: false });
    expect(intersections()).toHaveLength(0);
  });
});

describe("following the conversation", () => {
  it("keeps a reader at the bottom as messages arrive", () => {
    const scroller = render({ blocks: [user("u1")] });
    size(scroller, { scrollHeight: 1500, clientHeight: 400 });
    view!.rerender(tree({ blocks: [user("u1"), user("u2")] }));
    expect(scroller.scrollTop).toBe(1500);
  });

  it("keeps a reader further up on the same line when history loads above", () => {
    const box = { scrollHeight: 2000, clientHeight: 400 };
    const scroller = render({ blocks: [user("u2")] });
    size(scroller, box);
    scrollTo(scroller, 300);
    box.scrollHeight = 3000;
    view!.rerender(tree({ blocks: [user("u1"), user("u2")] }));
    expect(scroller.scrollTop).toBe(1300);
  });

  it("follows again once the reader scrolls back to the bottom", () => {
    const box = { scrollHeight: 2000, clientHeight: 400 };
    const scroller = render({ blocks: [user("u1")] });
    size(scroller, box);
    scrollTo(scroller, 300);
    scrollTo(scroller, 1590);
    box.scrollHeight = 2600;
    view!.rerender(tree({ blocks: [user("u1"), user("u2")] }));
    expect(scroller.scrollTop).toBe(2600);
  });

  it("re-pins when something inside grows after the paint", () => {
    const box = { scrollHeight: 1000, clientHeight: 400 };
    const scroller = render();
    size(scroller, box);
    box.scrollHeight = 1800;
    resizes()[0]!.fire();
    expect(scroller.scrollTop).toBe(1800);
  });

  it("leaves a reader who scrolled up where they are when something grows", () => {
    const box = { scrollHeight: 1000, clientHeight: 400 };
    const scroller = render();
    size(scroller, box);
    scrollTo(scroller, 100);
    box.scrollHeight = 1800;
    resizes()[0]!.fire();
    expect(scroller.scrollTop).toBe(100);
  });

  it("writes nothing while the tab is hidden, and pins once it is shown", () => {
    const box = { scrollHeight: 0, clientHeight: 0 };
    const scroller = render({ active: false });
    size(scroller, box);
    scroller.scrollTop = 0;
    view!.rerender(tree({ blocks: [user("u1"), user("u2")], active: false }));
    expect(scroller.scrollTop).toBe(0);
    Object.assign(box, { scrollHeight: 5000, clientHeight: 500 });
    view!.rerender(tree({ blocks: [user("u1"), user("u2")], active: true }));
    expect(scroller.scrollTop).toBe(5000);
  });
});

describe("search hits", () => {
  function track() {
    const seen: Array<string | null> = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement, arg) {
      expect(arg).toEqual({ block: "center" });
      seen.push(this.getAttribute("data-block"));
    });
    return seen;
  }

  it("takes the reader to the hit once", () => {
    const seen = track();
    render({ blocks: [user("u1"), user("u2")], focusId: "u1" });
    view!.rerender(tree({ blocks: [user("u1"), user("u2"), user("u3")], focusId: "u1" }));
    expect(seen).toEqual(["u1"]);
  });

  it("stops following the bottom after taking the reader to a hit", () => {
    track();
    const box = { scrollHeight: 2000, clientHeight: 400 };
    const blocks = [user("u1"), user("u2")];
    const scroller = render({ blocks });
    size(scroller, box);
    view!.rerender(tree({ blocks, focusId: "u1" }));
    // Where the browser's scrollIntoView left the reader.
    scroller.scrollTop = 500;
    box.scrollHeight = 3000;
    resizes()[0]!.fire();
    expect(scroller.scrollTop).toBe(500);
  });

  it("waits a few frames for a row that mounts late", () => {
    vi.useFakeTimers();
    const seen = track();
    render({ blocks: [user("u1")], focusId: "late" });
    vi.advanceTimersByTime(50);
    view!.rerender(tree({ blocks: [user("u1"), user("late")], focusId: "late" }));
    act(() => vi.advanceTimersByTime(50));
    expect(seen).toEqual(["late"]);
  });

  it("gives up on a row that never appears", () => {
    vi.useFakeTimers();
    const seen = track();
    const frame = vi.spyOn(window, "requestAnimationFrame");
    render({ blocks: [user("u1")], focusId: "gone" });
    act(() => vi.advanceTimersByTime(1000));
    expect(frame).toHaveBeenCalledTimes(20);
    view!.rerender(tree({ blocks: [user("u1"), user("gone")], focusId: "gone" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(seen).toEqual([]);
  });
});
