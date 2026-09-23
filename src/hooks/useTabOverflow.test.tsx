// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, mount } from "../test/dom";
import { act, renderHook } from "../test/renderHook";
import { useTabOverflow } from "./useTabOverflow";

/** happy-dom has no layout, so each strip reads its box from here. */
const box = { clientWidth: 400, scrollWidth: 400, scrollLeft: 0 };
const LAID_OUT = ["clientWidth", "scrollWidth", "scrollLeft"] as const;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  resize() {
    act(() => this.callback([], this as unknown as ResizeObserver));
  }
}

type Overflow = ReturnType<typeof useTabOverflow>;

function strip(watch = "a") {
  const sink: { current: Overflow | null; renders: number } = { current: null, renders: 0 };
  function Strip({ watch }: { watch: string }) {
    const overflow = useTabOverflow(watch);
    const { ref } = overflow;
    sink.current = overflow;
    sink.renders += 1;
    return <div ref={ref} />;
  }
  const view = mount(<Strip watch={watch} />);
  const el = view.container.firstElementChild as HTMLDivElement;
  const state = () => {
    const { overflowing, canScrollStart, canScrollEnd } = sink.current as Overflow;
    return { overflowing, canScrollStart, canScrollEnd };
  };
  return {
    el,
    sink,
    state,
    hook: () => sink.current as Overflow,
    rewatch: (next: string) => view.rerender(<Strip watch={next} />),
    scrolled: (left: number) => {
      box.scrollLeft = left;
      dispatch(el, new Event("scroll"));
    },
    unmount: view.unmount,
  };
}

const observer = () => FakeResizeObserver.instances.at(-1) as FakeResizeObserver;

describe("useTabOverflow", () => {
  beforeEach(() => {
    Object.assign(box, { clientWidth: 400, scrollWidth: 400, scrollLeft: 0 });
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    for (const key of LAID_OUT) {
      Object.defineProperty(HTMLDivElement.prototype, key, { configurable: true, get: () => box[key] });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of LAID_OUT) Reflect.deleteProperty(HTMLDivElement.prototype, key);
  });

  it("reports no overflow when every tab fits", () => {
    const view = strip();
    expect(view.state()).toEqual({ overflowing: false, canScrollStart: false, canScrollEnd: false });
    view.unmount();
  });

  it("offers only the end when the strip overflows at its start", () => {
    box.scrollWidth = 1000;
    const view = strip();
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: false, canScrollEnd: true });
    view.unmount();
  });

  it("follows the scroll position between both edges", () => {
    box.scrollWidth = 1000;
    const view = strip();
    view.scrolled(300);
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: true, canScrollEnd: true });
    view.scrolled(600);
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: true, canScrollEnd: false });
    view.scrolled(0);
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: false, canScrollEnd: true });
    view.unmount();
  });

  it("ignores a single pixel of overflow or offset", () => {
    box.scrollWidth = 401;
    const view = strip();
    expect(view.state().overflowing).toBe(false);
    view.unmount();

    box.scrollWidth = 1000;
    const scrolled = strip();
    scrolled.scrolled(1);
    expect(scrolled.state()).toEqual({ overflowing: true, canScrollStart: false, canScrollEnd: true });
    scrolled.scrolled(599);
    expect(scrolled.state()).toEqual({ overflowing: true, canScrollStart: true, canScrollEnd: false });
    scrolled.unmount();
  });

  it("clamps an elastic overscroll past either edge", () => {
    box.scrollWidth = 1000;
    const view = strip();
    view.scrolled(-40);
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: false, canScrollEnd: true });
    view.scrolled(700);
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: true, canScrollEnd: false });
    view.unmount();
  });

  it("rechecks when the strip resizes", () => {
    box.scrollWidth = 1000;
    const view = strip();
    expect(observer().observed).toEqual([view.el]);
    box.clientWidth = 1000;
    observer().resize();
    expect(view.state().overflowing).toBe(false);
    view.unmount();
  });

  it("rechecks when the watched tabs change without a resize", () => {
    const view = strip("a");
    box.scrollWidth = 900;
    view.rewatch("a,b,c");
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: false, canScrollEnd: true });
    view.unmount();
  });

  it("does not rerender on every scroll frame that changes nothing", () => {
    box.scrollWidth = 1000;
    const view = strip();
    view.scrolled(200);
    const renders = view.sink.renders;
    for (let left = 210; left < 400; left += 10) view.scrolled(left);
    observer().resize();
    // React may render once more to confirm the bail-out; it must not render per frame.
    expect(view.sink.renders - renders).toBeLessThanOrEqual(1);
    expect(view.state()).toEqual({ overflowing: true, canScrollStart: true, canScrollEnd: true });
    view.unmount();
  });

  it("scrolls four fifths of the strip per press, smoothly, either way", () => {
    box.scrollWidth = 2000;
    const view = strip();
    const scrollBy = vi.fn();
    view.el.scrollBy = scrollBy;
    view.hook().scroll("end");
    view.hook().scroll("start");
    expect(scrollBy.mock.calls).toEqual([
      [{ left: 320, behavior: "smooth" }],
      [{ left: -320, behavior: "smooth" }],
    ]);
    view.unmount();
  });

  it("scrolls at least 80px on a narrow strip", () => {
    box.clientWidth = 60;
    box.scrollWidth = 300;
    const view = strip();
    const scrollBy = vi.fn();
    view.el.scrollBy = scrollBy;
    view.hook().scroll("end");
    expect(scrollBy).toHaveBeenCalledWith({ left: 80, behavior: "smooth" });
    view.unmount();
  });

  it("stops observing and listening on unmount", () => {
    box.scrollWidth = 1000;
    const added = vi.spyOn(HTMLDivElement.prototype, "addEventListener");
    const removed = vi.spyOn(HTMLDivElement.prototype, "removeEventListener");
    const view = strip();
    const scrollListener = (spy: typeof added) =>
      spy.mock.calls.find(([type], i) => type === "scroll" && spy.mock.contexts[i] === view.el)?.[1];
    const listener = scrollListener(added);
    expect(listener).toBeTypeOf("function");
    view.unmount();
    expect(observer().disconnected).toBe(true);
    expect(scrollListener(removed)).toBe(listener);
  });

  it("does nothing until the ref is attached", () => {
    const hook = renderHook((watch: string) => useTabOverflow(watch), "a");
    hook.rerender("b");
    hook.result.current.scroll("end");
    expect(hook.result.current.overflowing).toBe(false);
    expect(FakeResizeObserver.instances).toEqual([]);
    hook.unmount();
  });
});
