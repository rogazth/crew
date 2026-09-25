import { describe, expect, it } from "vitest";
import { COMMAND_IDS, keysFor, repeatable } from "../commands";
import { resolveForward, type LiveCommand } from "../keymap";
import { newBrowserTab, openTab, patchBrowserTab, type TabState } from "../tabs";
import { createPageStore } from "./pageStore";
import { liveGuests, touch } from "./retention";
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

  it("keeps the retention budget through 10,000 switches among 1,000 pages", () => {
    let order: readonly string[] = [];
    let live = new Set<string>();
    const ms = timed(() => {
      for (let i = 0; i < 10_000; i++) {
        const visible = `p${(i * 7) % 1000}`;
        order = touch(order, visible);
        live = liveGuests({ order, visible, keep: 6, pinned: new Set() });
      }
    });
    expect(live.size).toBe(7);
    expect(ms).toBeLessThan(BUDGET_MS * 4);
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
