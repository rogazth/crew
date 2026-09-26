import { describe, expect, it } from "vitest";
import type { BrowserLease } from "../protocol";
import { createLeaseStore, SUMMON_MS } from "./leases";

const lease = (tab: string, holder = "Ada"): BrowserLease => ({
  tab,
  workspaceId: "w",
  holder,
  sessionId: `s-${holder}`,
  until: 0,
});

function store() {
  let now = 1000;
  const timers: { at: number; fn: () => void }[] = [];
  const leases = createLeaseStore(
    () => now,
    (fn, ms) => void timers.push({ at: now + ms, fn }),
  );
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) timer.fn();
  };
  let heard = 0;
  leases.subscribe(() => (heard += 1));
  return { leases, advance, heard: () => heard };
}

describe("lease store", () => {
  it("holds the leased tabs, with the same set back until they change", () => {
    const { leases, heard } = store();
    leases.set([lease("browser:a")]);
    const first = leases.held();
    expect([...first]).toEqual(["browser:a"]);
    leases.set([lease("browser:a")]);
    expect(leases.held()).toBe(first);
    expect(heard()).toBe(1);
    expect(leases.get("browser:a")?.holder).toBe("Ada");
  });

  it("a new holder of the same tab is news, though the set is the same", () => {
    const { leases, heard } = store();
    leases.set([lease("browser:a")]);
    leases.set([lease("browser:a", "Bob")]);
    expect(heard()).toBe(2);
    expect(leases.get("browser:a")?.holder).toBe("Bob");
  });

  it("a summoned tab is held until its lease takes over, or for a while", () => {
    const { leases, advance } = store();
    leases.summon("browser:b");
    expect(leases.held().has("browser:b")).toBe(true);
    advance(SUMMON_MS - 1);
    expect(leases.held().has("browser:b")).toBe(true);
    advance(1);
    expect(leases.held().has("browser:b")).toBe(false);
  });

  it("a released lease lets the tab go", () => {
    const { leases } = store();
    leases.set([lease("browser:a"), lease("browser:b")]);
    leases.set([lease("browser:b")]);
    expect([...leases.held()]).toEqual(["browser:b"]);
    expect(leases.get("browser:a")).toBeNull();
  });

  it("a list older than one already taken is dropped", () => {
    const { leases, heard } = store();
    // The event for Ada taking b arrives before the reply to a list asked for earlier.
    leases.set([lease("browser:a"), lease("browser:b")], 8);
    leases.set([lease("browser:a")], 7);
    expect([...leases.held()]).toEqual(["browser:a", "browser:b"]);
    expect(heard()).toBe(1);
    leases.set([], 9);
    expect([...leases.held()]).toEqual([]);
  });
});
