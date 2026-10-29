import { describe, expect, it } from "vitest";
import { GRACE_MS, IDLE_MS, liveGuests, sweep, touch, type MemoryPressure, type Warm } from "./retention";

const none: ReadonlySet<string> = new Set();
const MIN = 60 * 1000;
const NOW = 10 * IDLE_MS;

/** Each page with how long ago it was last used. */
function warmFrom(ago: Record<string, number>): Warm {
  return new Map(Object.entries(ago).map(([id, ms]) => [id, NOW - ms]));
}

function swept(
  warm: Warm,
  opts: { visible?: string | null; pinned?: string[]; busy?: string[]; pressure?: MemoryPressure; ids?: string[] } = {},
) {
  const result = sweep({
    warm,
    ids: new Set(opts.ids ?? [...warm.keys(), ...(opts.pinned ?? []), ...(opts.visible ? [opts.visible] : [])]),
    visible: opts.visible ?? null,
    pinned: new Set(opts.pinned),
    busy: new Set(opts.busy),
    pressure: opts.pressure ?? "normal",
    now: NOW,
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

describe("sweep", () => {
  it("lets a hidden page go cold after an hour unused", () => {
    expect(swept(warmFrom({ fresh: 59 * MIN, stale: IDLE_MS })).ids).toEqual(["fresh"]);
  });

  it("keeps any number of recent pages while memory is fine", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`p${n}`, n * MIN]));
    expect(swept(warmFrom(many)).ids).toHaveLength(40);
  });

  it("returns the same map when nothing goes cold", () => {
    const warm = warmFrom({ a: MIN, b: 2 * MIN });
    expect(swept(warm).result).toBe(warm);
  });

  it("drops pages that were closed", () => {
    expect(swept(warmFrom({ a: 0, gone: 0 }), { ids: ["a"] }).ids).toEqual(["a"]);
  });

  it("keeps the visible and pinned pages warm, however long ago they were first shown", () => {
    const { result, ids } = swept(warmFrom({ v: 2 * IDLE_MS, p: 2 * IDLE_MS }), { visible: "v", pinned: ["p", "q"] });
    expect(ids).toEqual(["p", "q", "v"]);
    expect(result.get("v")).toBe(NOW);
    expect(result.get("p")).toBe(NOW);
  });

  it("spares a busy workspace's pages and restarts their clock", () => {
    const { result, ids } = swept(warmFrom({ busy: 2 * IDLE_MS, idle: 2 * IDLE_MS }), { busy: ["busy"] });
    expect(ids).toEqual(["busy"]);
    expect(result.get("busy")).toBe(NOW);
  });

  it("does not warm a cold page because its workspace is busy", () => {
    expect(swept(new Map(), { ids: ["cold"], busy: ["cold"] }).ids).toEqual([]);
  });

  it("under moderate pressure lets the least recently used page past its grace go, one a sweep", () => {
    const warm = warmFrom({ recent: GRACE_MS - 1, older: 10 * MIN, oldest: 20 * MIN });
    const first = swept(warm, { pressure: "moderate" });
    expect(first.ids).toEqual(["older", "recent"]);
    expect(swept(first.result, { pressure: "moderate" }).ids).toEqual(["recent"]);
  });

  it("under moderate pressure keeps pages shown within the grace", () => {
    const warm = warmFrom({ a: MIN, b: 2 * MIN });
    expect(swept(warm, { pressure: "moderate" }).result).toBe(warm);
  });

  it("under moderate pressure still spares busy pages", () => {
    expect(swept(warmFrom({ busy: 30 * MIN, idle: 10 * MIN }), { pressure: "moderate", busy: ["busy"] }).ids).toEqual([
      "busy",
    ]);
  });

  it("under critical pressure keeps only the visible and pinned pages", () => {
    const warm = warmFrom({ v: 0, p: 0, busy: 0, fresh: 0 });
    expect(swept(warm, { pressure: "critical", visible: "v", pinned: ["p"], busy: ["busy"] }).ids).toEqual(["p", "v"]);
  });
});
