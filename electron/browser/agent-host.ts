/**
 * Agents driving pages, put together: the tools, the tab → guest registry
 * they drive through, and the connections that bring calls in: one to this
 * Mac's crewd, and one to each machine in the address book.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import { app, BrowserWindow, nativeImage, powerMonitor } from "electron";
import type { BrowserHostPage } from "../../src/lib/protocol";
import { createAgentTools, type Content } from "./agent-tools";
import { linkBrowserHost, type DaemonInfo, type HostLink } from "./host-link";
import { startRemoteHosts, type Machine } from "./remote-hosts";
import { hasGuest, releaseUnleased, tabDriver } from "./tab-guests";

const tools = createAgentTools(tabDriver());

/** What counts as the user taking the page back: a press, a key or a scroll, not the pointer passing over. */
const USER_INPUT = new Set(["mouseDown", "rawKeyDown", "keyDown", "mouseWheel", "gestureScrollBegin", "touchStart"]);

export function noteGuestInput(webContentsId: number, type: string | undefined): void {
  if (type && USER_INPUT.has(type)) tools.noteUserInput(webContentsId);
}

/** The Mac's name as its owner set it, for a machine with more than one Mac to tell them apart. */
function macName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // Falls back to the host name.
    }
  }
  return os.hostname().replace(/\.local$/, "");
}

const JPEG_QUALITY = 80;

/** A screenshot crosses the network as JPEG when that is smaller: a page's PNG is often megabytes. */
export function smallerImages(result: Content[]): Content[] {
  return result.map((block) => {
    if (block.type !== "image" || block.mimeType !== "image/png") return block;
    const image = nativeImage.createFromBuffer(Buffer.from(block.data, "base64"));
    if (image.isEmpty()) return block;
    const jpeg = image.toJPEG(JPEG_QUALITY).toString("base64");
    return jpeg.length < block.data.length ? { type: "image", data: jpeg, mimeType: "image/jpeg" } : block;
  });
}

type Hosts = {
  /** This Mac's crewd: where it is now. */
  info: () => DaemonInfo | null;
  /** The machines to be a host of. */
  machines: () => Promise<Machine[]>;
  /** Called with a function that dials the address book again. */
  onMachinesChanged: (refresh: () => void) => void;
};

export function startBrowserHost({ info, machines, onMachinesChanged }: Hosts): { stop(): void } {
  const hello = { name: macName(), acks: true };
  // Each daemon's own lease list: a tab keeps its debugger while any of them leases it.
  const leasedBy = new Map<string, ReadonlySet<string>>();
  const setLeases = (source: string, tabs: ReadonlySet<string>) => {
    if (tabs.size === 0) leasedBy.delete(source);
    else leasedBy.set(source, tabs);
    const all = new Set<string>();
    for (const set of leasedBy.values()) for (const tab of set) all.add(tab);
    for (const tab of releaseUnleased(all)) tools.forgetTab(tab);
  };
  const focused = () => BrowserWindow.getFocusedWindow() !== null;
  const tellFocus = (link: HostLink) => {
    if (focused()) void link.request("browser_host_focus").catch(() => {});
  };

  let remotes: ReturnType<typeof startRemoteHosts> | null = null;
  const local = linkBrowserHost({
    info,
    tools,
    hello,
    onLeases: (tabs) => setLeases("local", tabs),
    onReady: () => {
      tellFocus(local);
      remotes?.pagesChanged();
    },
    onEvent: (event) => {
      if (event === "browser-pages-changed") remotes?.pagesChanged();
    },
  });
  remotes = startRemoteHosts({
    tools,
    hello,
    machines,
    localPages: () => local.request<BrowserHostPage[]>("browser_pages_list"),
    taken: (tab, pages) => hasGuest(tab) || pages.some((page) => page.pageId === tab),
    onLeases: (machine, tabs) => setLeases(machine, tabs),
    shrink: smallerImages,
    onReady: tellFocus,
  });
  onMachinesChanged(() => remotes?.refresh());

  // The user is at this Mac: an agent's next tab opens here.
  const onFocus = () => {
    for (const link of [local, ...(remotes?.links() ?? [])]) void link.request("browser_host_focus").catch(() => {});
  };
  app.on("browser-window-focus", onFocus);
  // A sleeping Mac keeps its sockets open; closed first, every machine knows at once that it went.
  const onSuspend = () => remotes?.pause();
  const onResume = () => remotes?.redial();
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onResume);

  return {
    stop: () => {
      app.off("browser-window-focus", onFocus);
      powerMonitor.off("suspend", onSuspend);
      powerMonitor.off("resume", onResume);
      remotes?.stop();
      local.stop();
    },
  };
}
