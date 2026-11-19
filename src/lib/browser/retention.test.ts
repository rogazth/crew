import { describe, expect, it } from "vitest";
import { GRACE_MS, liveGuests, sweep, touch, type MemoryPressure, type Warm } from "./retention";

const none: ReadonlySet<string> = new Set();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = 100 * HOUR;

/** Each page with how long ago it was last used. */
function warmFrom(ago: Record<string, number>): Warm {
  return new Map(Object.entries(ago).map(([id, ms]) => [id, NOW - ms]));
}

function swept(
  warm: Warm,
  opts: {
    visible?: string | null;
    pinned?: string[];
    busy?: string[];
    pressure?: MemoryPressure;
    ids?: string[];
    now?: number;
  } = {},
) {
  const result = sweep({
    warm,
    ids: new Set(opts.ids ?? [...warm.keys(), ...(opts.pinned ?? []), ...(opts.visible ? [opts.visible] : [])]),
    visible: opts.visible ?? null,
    pinned: new Set(opts.pinned),
    busy: new Set(opts.busy),
    pressure: opts.pressure ?? "normal",
    now: opts.now ?? NOW,
  });
  return { result, ids: [...result.keys()].sort() };
}

describe("touch", () => {
  it("marks pages used now", () => {
    expect([...touch(new Map([["a", 1]]), ["a", "b"], 5)]).toEqual([
      ["a", 5],
      ["b", 5],
    ]);
  });

  it("returns the same map when nothing changes", () => {
    const warm = new Map([["a", 5]]);
    expect(touch(warm, ["a"], 5)).toBe(warm);
    expect(touch(warm, [], 9)).toBe(warm);
  });
});

describe("liveGuests", () => {
  it("is the warm pages, the pinned ones and the visible one", () => {
    const live = liveGuests({ warm: warmFrom({ a: 0, b: 0 }), visible: "v", pinned: new Set(["p"]) });
    expect([...live].sort()).toEqual(["a", "b", "p", "v"]);
  });

  it("is nothing with no page warm, pinned or visible", () => {
    expect(liveGuests({ warm: new Map(), visible: null, pinned: none }).size).toBe(0);
  });
});

describe("sweep, memory fine", () => {
  it("keeps hidden pages forever while memory is fine", () => {
    const warm = warmFrom({ day: 24 * HOUR, week: 7 * 24 * HOUR, fresh: MIN });
    expect(swept(warm).result).toBe(warm);
    expect(swept(warm, { pressure: "moderate" }).result).toBe(warm);
  });

  it("keeps any number of pages", () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`p${n}`, n * HOUR]));
    expect(swept(warmFrom(many)).ids).toHaveLength(200);
  });
});

describe("sweep, memory pressure", () => {
  it("takes nothing under moderate pressure", () => {
    const warm = warmFrom({ a: 9 * HOUR, b: 3 * HOUR, c: HOUR });
    expect(swept(warm, { pressure: "moderate" }).result).toBe(warm);
  });

  it("under critical pressure takes exactly one page a sweep, least recently used first", () => {
    let warm = warmFrom({ newer: 10 * MIN, oldest: 3 * HOUR, older: HOUR });
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const before = new Set(warm.keys());
      warm = swept(warm, { pressure: "critical" }).result;
      const gone = [...before].filter((id) => !warm.has(id));
      expect(gone.length).toBeLessThanOrEqual(1);
      order.push(...gone);
    }
    expect(order).toEqual(["oldest", "older", "newer"]);
    expect(warm.size).toBe(0);
  });

  it("under critical pressure keeps a page seen within the grace", () => {
    const warm = warmFrom({ a: GRACE_MS - 1, b: MIN });
    expect(swept(warm, { pressure: "critical" }).result).toBe(warm);
    expect(swept(warm, { pressure: "critical", now: NOW + GRACE_MS }).ids).toEqual(["b"]);
  });

  it("under critical pressure takes a busy workspace's pages only once no other is left", () => {
    let warm = warmFrom({ busyOld: 9 * HOUR, busyNew: 2 * HOUR, idle: 10 * MIN });
    const busy = ["busyOld", "busyNew"];
    warm = swept(warm, { pressure: "critical", busy }).result;
    expect([...warm.keys()].sort()).toEqual(["busyNew", "busyOld"]);
    warm = swept(warm, { pressure: "critical", busy }).result;
    expect([...warm.keys()]).toEqual(["busyNew"]);
  });

  it("under critical pressure passes over busy pages in their grace too", () => {
    const warm = warmFrom({ busy: MIN, fresh: MIN });
    expect(swept(warm, { pressure: "critical", busy: ["busy"] }).result).toBe(warm);
  });

  it("under critical pressure never takes the visible or pinned pages", () => {
    const warm = warmFrom({ v: 9 * HOUR, p: 9 * HOUR });
    const { ids } = swept(warm, { pressure: "critical", visible: "v", pinned: ["p"] });
    expect(ids).toEqual(["p", "v"]);
  });

  it("under critical pressure takes nothing while every hidden page is in its grace", () => {
    const warm = warmFrom({ a: MIN, b: 2 * MIN, c: GRACE_MS - 1 });
    expect(swept(warm, { pressure: "critical" }).result).toBe(warm);
  });
});

describe("sweep, bookkeeping", () => {
  it("drops pages that were closed", () => {
    expect(swept(warmFrom({ a: 0, gone: 0 }), { ids: ["a"] }).ids).toEqual(["a"]);
  });

  it("keeps the visible and pinned pages warm, even ones that were cold", () => {
    const { ids } = swept(warmFrom({ v: 2 * HOUR, p: 2 * HOUR }), { visible: "v", pinned: ["p", "q"] });
    expect(ids).toEqual(["p", "q", "v"]);
  });

  it("does not warm a cold page because its workspace is busy", () => {
    expect(swept(new Map(), { ids: ["cold"], busy: ["cold"] }).ids).toEqual([]);
  });

  it("returns the same map when nothing moves, a visible, pinned and busy page included", () => {
    const first = swept(warmFrom({ v: 0, p: 0, busy: HOUR, a: MIN }), {
      visible: "v",
      pinned: ["p"],
      busy: ["busy"],
    }).result;
    const again = sweep({
      warm: first,
      ids: new Set(first.keys()),
      visible: "v",
      pinned: new Set(["p"]),
      busy: new Set(["busy"]),
      pressure: "moderate",
      now: NOW + 10 * MIN,
    });
    expect(again).toBe(first);
  });

  it("starts a page's clock when it stops being in use, with its grace", () => {
    const inUse = swept(warmFrom({ p: 9 * HOUR }), { pinned: ["p"] }).result;
    const later = NOW + 3 * HOUR;
    const released = swept(inUse, { ids: ["p"], now: later }).result;
    expect(released.get("p")).toBe(later);
    expect(swept(released, { ids: ["p"], now: later + MIN, pressure: "critical" }).ids).toEqual(["p"]);
    expect(swept(released, { ids: ["p"], now: later + GRACE_MS, pressure: "critical" }).ids).toEqual([]);
  });
});
