import { openUrl } from "./host";

/** Agent output is untrusted: only what a browser would follow leaves the app. */
const OPENABLE = /^(?:https?|mailto):/i;
const WEB = /^https?:/i;

let inCrew: ((url: string) => void) | null = null;

/** While set, web links open as a Crew page; null sends them to the default browser. */
export function routeLinks(open: ((url: string) => void) | null): void {
  inCrew = open;
}

/** A link from a chat or a terminal. mailto always goes to the mail app. */
export function openLink(uri: string): void {
  if (!OPENABLE.test(uri)) return;
  if (inCrew && WEB.test(uri)) {
    inCrew(uri);
    return;
  }
  void openUrl(uri).catch(() => {});
}
