import { beforeEach, describe, expect, it } from "vitest";
import { BLANK_PAGE, createPageStore, type PageStore } from "./pageStore";

/** A frame, run by hand, so a test can say when the flush happened. */
let frames: Array<() => void> = [];
let store: PageStore;

function paint() {
  const queued = frames;
  frames = [];
  for (const frame of queued) frame();
}

/** How many times each subscriber was told. */
function listen(id: string) {
  const heard = { count: 0 };
  const stop = store.subscribe(id, () => (heard.count += 1));
  return { heard, stop };
}

beforeEach(() => {
  frames = [];
  store = createPageStore((flush) => frames.push(flush));
});

describe("pageStore", () => {
  it("answers with the frozen blank page for an id it has never seen", () => {
    expect(store.get("nope")).toBe(BLANK_PAGE);
    expect(Object.isFrozen(BLANK_PAGE)).toBe(true);
  });

  it("is current before the flush", () => {
    store.update("a", { url: "https://example.com/", loading: true });
    expect(store.get("a")).toMatchObject({ url: "https://example.com/", loading: true, title: "" });
    expect(BLANK_PAGE.url).toBe("about:blank");
  });

  it("keeps the same object and schedules nothing when nothing changed", () => {
    store.update("a", { url: "https://example.com/", loading: true });
    paint();
    const before = store.get("a");
    const { heard } = listen("a");
    store.update("a", { url: "https://example.com/", loading: true });
    expect(store.get("a")).toBe(before);
    expect(frames).toHaveLength(0);
    paint();
    expect(heard.count).toBe(0);
  });

  it("leaves an unseen id on the blank page when the patch matches it", () => {
    store.update("a", { loading: false, error: null });
    expect(store.get("a")).toBe(BLANK_PAGE);
    expect(frames).toHaveLength(0);
  });

  it("tells a subscriber once for a burst of updates", () => {
    const { heard } = listen("a");
    store.update("a", { loading: true });
    store.update("a", { url: "https://example.com/" });
    store.update("a", { title: "Example" });
    store.update("a", { loading: false });
    expect(frames).toHaveLength(1);
    expect(heard.count).toBe(0);
    paint();
    expect(heard.count).toBe(1);
    expect(store.get("a")).toMatchObject({ url: "https://example.com/", title: "Example", loading: false });
  });

  it("compares errors by value, not identity", () => {
    const error = { code: -102, description: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" };
    store.update("a", { error });
    paint();
    const before = store.get("a");
    store.update("a", { error: { ...error } });
    expect(store.get("a")).toBe(before);
    store.update("a", { error: { ...error, code: -105 } });
    expect(store.get("a")).not.toBe(before);
    store.update("a", { error: null });
    expect(store.get("a").error).toBeNull();
  });

  it("keeps pages apart", () => {
    const a = listen("a");
    const b = listen("b");
    store.update("a", { loading: true });
    paint();
    expect(a.heard.count).toBe(1);
    expect(b.heard.count).toBe(0);
    expect(store.get("b")).toBe(BLANK_PAGE);
  });

  it("stops telling a subscriber that unsubscribed", () => {
    const { heard, stop } = listen("a");
    stop();
    store.update("a", { loading: true });
    paint();
    expect(heard.count).toBe(0);
  });

  it("forgets a dropped page, even with a flush pending", () => {
    const { heard } = listen("a");
    store.update("a", { loading: true });
    store.drop("a");
    paint();
    expect(heard.count).toBe(0);
    expect(store.get("a")).toBe(BLANK_PAGE);
  });

  it("does not let a stale unsubscribe touch a page subscribed again after a drop", () => {
    const old = listen("a");
    store.drop("a");
    const fresh = listen("a");
    old.stop();
    store.update("a", { loading: true });
    paint();
    expect(fresh.heard.count).toBe(1);
  });

  it("keeps an update made during a flush for the next one", () => {
    let calls = 0;
    store.subscribe("a", () => {
      calls += 1;
      if (calls === 1) store.update("a", { title: "Later" });
    });
    store.update("a", { loading: true });
    paint();
    expect(calls).toBe(1);
    expect(store.get("a").title).toBe("Later");
    expect(frames).toHaveLength(1);
    paint();
    expect(calls).toBe(2);
  });

  it("survives a subscriber that unsubscribes another during the flush", () => {
    const second = { count: 0 };
    let stopSecond = () => {};
    store.subscribe("a", () => stopSecond());
    stopSecond = store.subscribe("a", () => (second.count += 1));
    const third = listen("a");
    store.update("a", { loading: true });
    paint();
    expect(second.count).toBe(0);
    expect(third.heard.count).toBe(1);
  });

  it("survives a subscriber that drops its own page during the flush", () => {
    const after = { count: 0 };
    store.subscribe("a", () => store.drop("a"));
    store.subscribe("a", () => (after.count += 1));
    store.update("a", { loading: true });
    paint();
    expect(after.count).toBe(0);
    expect(store.get("a")).toBe(BLANK_PAGE);
  });
});
