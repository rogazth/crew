import { openUrl } from "./host";
import { IS_MAC } from "./hotkey";

/** Agent output is untrusted: only what a browser would follow leaves the app. */
const OPENABLE = /^(?:https?|mailto):/i;
const WEB = /^https?:/i;

/** The chord that sends a web link to the default browser even while links open in Crew. */
export const BROWSER_CLICK = IS_MAC ? "⌘⇧" : "Ctrl+Shift+";

type Modifiers = { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

function wantsBrowser(event: Modifiers | undefined): boolean {
  return !!event?.shiftKey && (IS_MAC ? event.metaKey : event.ctrlKey);
}

let inCrew: ((url: string) => void) | null = null;

/** While set, web links open as a Crew page; null sends them to the default browser. */
export function routeLinks(open: ((url: string) => void) | null): void {
  inCrew = open;
}

/** A link from a chat or a terminal. mailto always goes to the mail app; ⌘⇧-click sends a web link out too. */
export function openLink(uri: string, event?: Modifiers): void {
  if (!OPENABLE.test(uri)) return;
  if (inCrew && WEB.test(uri) && !wantsBrowser(event)) {
    inCrew(uri);
    return;
  }
  void openUrl(uri).catch(() => {});
}
