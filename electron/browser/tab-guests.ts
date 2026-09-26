/**
 * Which guest shows which tab. Main registers guests by webContents id, and
 * only the window knows the tab each one belongs to, so the window tells it
 * on every attach. A tab revived after going cold gets a new guest, and the
 * next call finds that one.
 */

import type { WebContents } from "electron";
import { CHANNELS, type MountRequest } from "../../src/lib/browser/bridge";
import type { Driver, PageRef } from "./agent-tools";
import { cdpPage, releasePage } from "./cdp-page";

/** A cold tab, or one in a workspace this window has not opened, gets this long to come up. */
export const MOUNT_TIMEOUT_MS = 15_000;

const tabGuests = new Map<string, WebContents>();
const waiters = new Map<string, Set<(guest: WebContents) => void>>();
/** The window that shows the tabs; a mount request goes to it. */
let window: WebContents | null = null;

export function setTabWindow(host: WebContents): void {
  window = host;
}

/** The window says `guest` is `tab`'s page. The caller has checked the window owns it. */
export function bindTab(tab: string, guest: WebContents): void {
  tabGuests.set(tab, guest);
  guest.once("destroyed", () => {
    if (tabGuests.get(tab) === guest) tabGuests.delete(tab);
  });
  const waiting = waiters.get(tab);
  waiters.delete(tab);
  for (const resolve of waiting ?? []) resolve(guest);
}

function liveGuest(tab: string): WebContents | null {
  const guest = tabGuests.get(tab);
  return guest && !guest.isDestroyed() ? guest : null;
}

/** The tab's guest, asking the window to mount it when there is none. */
async function guestFor(tab: string, ref: PageRef | undefined, open: boolean): Promise<WebContents> {
  const live = liveGuest(tab);
  if (live) return live;
  const host = window;
  if (!host || host.isDestroyed()) throw new Error("Open Crew's window to use the browser.");
  if (!ref) throw new Error(`Tab ${tab} is not open.`);
  const arrived = new Promise<WebContents>((resolve, reject) => {
    const done = (guest: WebContents) => {
      clearTimeout(timer);
      resolve(guest);
    };
    const timer = setTimeout(() => {
      waiters.get(tab)?.delete(done);
      reject(new Error(`Tab ${tab} did not come up within ${MOUNT_TIMEOUT_MS / 1000} s; try again.`));
    }, MOUNT_TIMEOUT_MS);
    let set = waiters.get(tab);
    if (!set) waiters.set(tab, (set = new Set()));
    set.add(done);
  });
  const request: MountRequest = { tab, context: ref.context, url: ref.url, title: ref.title, open };
  host.send(CHANNELS.mount, request);
  return arrived;
}

export function tabDriver(): Driver {
  return {
    page: async (tab, ref) => cdpPage(await guestFor(tab, ref, false)),
    open: async (tab, ref) => cdpPage(await guestFor(tab, ref, true)),
    isMac: process.platform === "darwin",
    now: Date.now,
  };
}

/** Tabs that lost their lease let go of the debugger; the rest keep theirs. Returns the tabs let go. */
export function releaseUnleased(leased: ReadonlySet<string>): string[] {
  const released: string[] = [];
  for (const [tab, guest] of tabGuests) {
    if (leased.has(tab)) continue;
    releasePage(guest);
    released.push(tab);
  }
  return released;
}
