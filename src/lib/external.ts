import { openUrl } from "./host";
import { IS_MAC } from "./hotkey";

/** Agent output is untrusted: only what a browser would follow leaves the app. */
const OPENABLE = /^(?:https?|mailto):/i;
const WEB = /^https?:/i;

/** The chord that sends a web link to the default browser even while links open in Crew. */
export const BROWSER_CLICK = IS_MAC ? "⌘⇧" : "Ctrl+Shift+";

type Modifiers = { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

const modHeld = (event: Modifiers | undefined) => !!event && (IS_MAC ? event.metaKey : event.ctrlKey);

function wantsBrowser(event: Modifiers | undefined): boolean {
  return !!event?.shiftKey && modHeld(event);
}

/** How a link opens as a Crew page: `background` leaves the tab on screen, and the keyboard, where they are. */
export type LinkOpen = { background: boolean };

let inCrew: ((url: string, how: LinkOpen) => void) | null = null;

/** While set, web links open as a Crew page; null sends them to the default browser. */
export function routeLinks(open: ((url: string, how: LinkOpen) => void) | null): void {
  inCrew = open;
}

/**
 * A link from a chat or a terminal. mailto always goes to the mail app; ⌘⇧-click
 * sends a web link out too, and ⌘-click opens its Crew page behind, as a browser does.
 */
export function openLink(uri: string, event?: Modifiers): void {
  if (!OPENABLE.test(uri)) return;
  if (inCrew && WEB.test(uri) && !wantsBrowser(event)) {
    inCrew(uri, { background: modHeld(event) });
    return;
  }
  void openUrl(uri).catch(() => {});
}
