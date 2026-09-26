/**
 * Agents driving pages, put together: the tools, the tab → guest registry
 * they drive through, and the connection that brings calls from crewd.
 */

import { createAgentTools } from "./agent-tools";
import { linkBrowserHost } from "./host-link";
import { releaseUnleased, tabDriver } from "./tab-guests";

const tools = createAgentTools(tabDriver());

/** What counts as the user taking the page back: a press, a key or a scroll, not the pointer passing over. */
const USER_INPUT = new Set(["mouseDown", "rawKeyDown", "keyDown", "mouseWheel", "gestureScrollBegin", "touchStart"]);

export function noteGuestInput(webContentsId: number, type: string | undefined): void {
  if (type && USER_INPUT.has(type)) tools.noteUserInput(webContentsId);
}

export function startBrowserHost(info: () => { url: string; token: string } | null): { stop(): void } {
  return linkBrowserHost({
    info,
    tools,
    onLeases: (leased) => {
      for (const tab of releaseUnleased(leased)) tools.forgetTab(tab);
    },
  });
}
