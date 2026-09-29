import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { bindTab, releaseUnleased } from "./tab-guests";

/** Just enough of a guest: its `destroyed` listeners, counted. */
function fakeGuest() {
  const listeners: (() => void)[] = [];
  const guest = {
    once: (event: string, fn: () => void) => {
      if (event === "destroyed") listeners.push(fn);
      return guest;
    },
    isDestroyed: () => false,
    destroy: () => listeners.splice(0).forEach((fn) => fn()),
    listeners,
  };
  return guest;
}

describe("tab guests", () => {
  it("watches a guest once however often the window reports it, and forgets it when it goes", () => {
    const guest = fakeGuest();
    const other = fakeGuest();
    for (let i = 0; i < 5; i += 1) bindTab("browser:a", guest as unknown as WebContents);
    bindTab("browser:b", other as unknown as WebContents);
    expect(guest.listeners).toHaveLength(1);
    guest.destroy();
    // Only the guest that went is forgotten: nothing leased, so every tab still bound is listed.
    expect(releaseUnleased(new Set())).toEqual(["browser:b"]);
  });
});
