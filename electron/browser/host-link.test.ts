import { describe, expect, it } from "vitest";
import { leaseFeed, onLocalClock } from "./host-link";

describe("host link", () => {
  it("drops a lease list older than one it already acted on", () => {
    const heard: string[][] = [];
    const feed = leaseFeed((tabs) => heard.push([...tabs]));
    feed({ seq: 5, leases: [{ tab: "browser:a" }, { tab: "browser:b" }] });
    // The register reply, built before that change, arrives after it.
    feed({ seq: 4, leases: [{ tab: "browser:a" }] });
    feed({ seq: 5, leases: [{ tab: "browser:a" }, { tab: "browser:b" }] });
    feed({ seq: 6, leases: [] });
    feed({ leases: "junk" });
    expect(heard).toEqual([["browser:a", "browser:b"], ["browser:a", "browser:b"], []]);
  });

  it("counts a call's budget from when it got here, not by the sending machine's clock", () => {
    const sent = { callId: 1, tab: "browser:a", tool: "browser_click", args: {}, deadline: 5_000, timeoutMs: 35_000 };
    expect(onLocalClock(sent, 1_000_000).deadline).toBe(1_035_000);
    // A crewd from before the budget was sent keeps its deadline.
    const { timeoutMs: _, ...old } = sent;
    expect(onLocalClock(old, 1_000_000).deadline).toBe(5_000);
  });
});
