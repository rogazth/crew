import { describe, expect, it } from "vitest";
import { leaseFeed } from "./host-link";

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
});
