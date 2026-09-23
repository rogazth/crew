import { RESTORE_PREFIX } from "./bridge";
import { isWebUrl } from "./url";

/**
 * What a guest loads first. The address bar works while the saved stack is
 * still being fetched, and a URL typed in that gap wins: waiting out the
 * fetch and then restoring would throw away what was just asked for.
 */
export function openingSrc(restored: string | null, queued: string | null): { src: string; restoring: boolean } {
  if (queued !== null && isWebUrl(queued)) return { src: queued, restoring: false };
  const src = restored ? restored : "about:blank";
  return { src, restoring: src.startsWith(RESTORE_PREFIX) };
}
