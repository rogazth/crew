import { describe, expect, it } from "vitest";
import { COMMAND_IDS, keysFor, repeatable } from "../commands";
import { resolveForward, type LiveCommand } from "../keymap";
import { newBrowserTab, openTab, panesOf, patchBrowserTab, reorderTabs, type TabRegistry, type TabState } from "../tabs";
import { createPageStore } from "./pageStore";
import { liveGuests, sweep, SWEEP_MS, touch, type Warm } from "./retention";
import { capSnapshot } from "./snapshot";
import { buildSuggestions } from "./suggest";
import { resolveAddress } from "./url";

/** Generous on purpose: these catch an accidental quadratic, not a slow CI box. */
const BUDGET_MS = 250;

function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("stress", () => {
  it("forwards 100,000 chords against every command inside the budget", () => {
    const live: LiveCommand[] = COMMAND_IDS.flatMap((id) => {
      const keys = keysFor(id);
      return keys ? [{ id, keys, repeat: repeatable(id) }] : [];
    });
    const keys = ["l", "[", "]", "w", "k", "x", "1", "=", "Enter", "a"];
    let forwarded = 0;
    const ms = timed(() => {
      for (let i = 0; i < 100_000; i++) {
        const key = keys[i % keys.length]!;
        const hit = resolveForward(
          { type: "keyDown", key, code: "", meta: i % 2 === 0, ctrl: false, alt: false, shift: false, isAutoRepeat: false },
          live,
          true,
        );
        if (hit) forwarded++;
      }
    });
    expect(forwarded).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("tells each page once per flush, however many of 100,000 events hit it", () => {
    const flushes: (() => void)[] = [];
    const store = createPageStore((flush) => flushes.push(flush));
    const heard = new Map<string, number>();
    for (let page = 0; page < 200; page++) {
      const id = `p${page}`;
      store.subscribe(id, () => heard.set(id, (heard.get(id) ?? 0) + 1));
    }
    const ms = timed(() => {
      for (let i = 0; i < 100_000; i++) store.update(`p${i % 200}`, { title: `t${i}`, loading: i % 3 === 0 });
      for (const flush of flushes.splice(0)) flush();
    });
    expect([...heard.values()].every((count) => count === 1)).toBe(true);
    expect(heard.size).toBe(200);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("sweeps 1,000 pages through 10,000 switches", () => {
    const ids = new Set(Array.from({ length: 1000 }, (_, n) => `p${n}`));
    const none = new Set<string>();
    let warm: Warm = new Map();
    let live = new Set<string>();
    let now = 0;
    const ms = timed(() => {
      for (let i = 0; i < 10_000; i++) {
        now += 10_000;
        const visible = `p${(i * 7) % 1000}`;
        warm = touch(warm, [visible], now);
        if (i % 3 === 0) warm = sweep({ warm, ids, visible, pinned: none, busy: none, pressure: "normal", now });
        live = liveGuests({ warm, visible, pinned: none });
      }
    });
    // Memory is fine throughout: every page once shown stays warm, however long ago.
    expect(live.size).toBe(1000);
    // All 1,000 stay warm, so each switch copies a map of them: about 75 µs a switch alone,
    // with room for a loaded machine running the whole suite.
    expect(ms).toBeLessThan(BUDGET_MS * 8);
  });

  it("sweeps 200 open pages cheaply, and hands back the same map while nothing moves", () => {
    const ids = new Set(Array.from({ length: 200 }, (_, n) => `p${n}`));
    const pinned = new Set(["p1", "p2", "p3"]);
    const busy = new Set(Array.from({ length: 50 }, (_, n) => `p${n + 100}`));
    let now = 24 * 60 * 60 * 1000;
    let warm: Warm = new Map([...ids].map((id, n) => [id, now - n * 60_000]));
    const input = { ids, visible: "p0", pinned, busy, pressure: "normal" as const };
    warm = sweep({ ...input, warm, now });
    // A day of sweeps every 30 seconds, as the window runs them.
    const sweeps = (24 * 60 * 60 * 1000) / SWEEP_MS;
    let changed = 0;
    const ms = timed(() => {
      for (let i = 0; i < sweeps; i++) {
        now += SWEEP_MS;
        const next = sweep({ ...input, warm, now });
        if (next !== warm) changed++;
        warm = next;
      }
    });
    // No new map, so the window's state setter bails out and nothing re-renders.
    expect(changed).toBe(0);
    expect(warm.size).toBe(200);
    console.info(`sweep of 200 pages: ${((ms / sweeps) * 1000).toFixed(1)} µs each over ${sweeps} sweeps`);
    expect(ms / sweeps).toBeLessThan(1);
  });

  it("lists 200 panes of five workspaces, in the same order however their strips are dragged", () => {
    const strip = (w: number): TabState => {
      const tabs = Array.from({ length: 40 }, (_, n) => newBrowserTab(`https://w${w}.test/${n}`));
      return { tabs, activeId: tabs[0]!.id, closed: [] };
    };
    let registry: TabRegistry = Object.fromEntries(Array.from({ length: 5 }, (_, w) => [`w${w}`, strip(w)]));
    const order = panesOf(registry, "w0").map((pane) => pane.id);
    const runs = 10_000;
    let same = true;
    const ms = timed(() => {
      for (let i = 0; i < runs; i++) {
        // Every run drags the active strip's last tab to the front, as the window would re-list on each.
        const state = registry.w0!;
        const ids = state.tabs.map((tab) => tab.id);
        registry = { ...registry, w0: reorderTabs(state, [ids[ids.length - 1]!, ...ids.slice(0, -1)]) };
        const panes = panesOf(registry, "w0");
        if (i % 1000 === 0) same &&= panes.every((pane, n) => pane.id === order[n]);
      }
    });
    expect(same).toBe(true);
    console.info(`panesOf over 200 panes: ${((ms / runs) * 1000).toFixed(1)} µs each`);
    expect(ms / runs).toBeLessThan(1);
  });

  it("under critical pressure lets 200 pages go one a sweep, least recently used first", () => {
    const ids = new Set(Array.from({ length: 200 }, (_, n) => `p${n}`));
    const none = new Set<string>();
    let now = 24 * 60 * 60 * 1000;
    // p0 was used last, p199 first.
    let warm: Warm = new Map([...ids].map((id, n) => [id, now - (n + 10) * 60_000]));
    const gone: string[] = [];
    const ms = timed(() => {
      for (let i = 0; i < 200; i++) {
        now += SWEEP_MS;
        const next = sweep({ warm, ids, visible: null, pinned: none, busy: none, pressure: "critical", now });
        gone.push(...[...warm.keys()].filter((id) => !next.has(id)));
        warm = next;
      }
    });
    expect(gone).toEqual([...ids].reverse());
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("patches 500 tabs without copying state that did not change", () => {
    let state: TabState = { tabs: [], activeId: null, closed: [] };
    for (let i = 0; i < 500; i++) state = openTab(state, newBrowserTab(`https://s${i}.com/`));
    const ids = state.tabs.map((tab) => tab.id);
    let copied = 0;
    let kept = 0;
    const ms = timed(() => {
      for (let round = 0; round < 20; round++) {
        for (const id of ids) {
          const next = patchBrowserTab(state, id, { title: `r${round}` });
          if (next !== state) copied++;
          state = next;
          // The same title again, as a redirect chain reports it: nothing to write.
          if (patchBrowserTab(state, id, { title: `r${round}` }) === state) kept++;
        }
      }
    });
    expect(copied).toBe(10_000);
    expect(kept).toBe(10_000);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("caps a 1,000-entry stack with a megabyte of page state under 256 KB", () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      url: `https://site.com/${i}`,
      title: `Page ${i}`,
      pageState: "x".repeat(1024),
    }));
    let capped: ReturnType<typeof capSnapshot> = null;
    const ms = timed(() => {
      capped = capSnapshot({ entries, index: 700 });
    });
    expect(capped).not.toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(capped!.entries)).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(capped!.entries[capped!.index]?.url).toBe("https://site.com/700");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("builds suggestions for 10,000 keystrokes over a full dropdown", () => {
    const history = Array.from({ length: 50 }, (_, i) => ({ url: `https://docs${i}.dev/guide`, title: `Guide ${i}` }));
    const typed = "docs.dev/guide";
    const ms = timed(() => {
      for (let i = 0; i < 10_000; i++) {
        const input = typed.slice(0, (i % typed.length) + 1);
        buildSuggestions(input, resolveAddress(input), history);
      }
    });
    expect(ms).toBeLessThan(BUDGET_MS * 4);
  });
});
