import { useCallback, useSyncExternalStore } from "react";
import { pages, type PageState } from "../lib/browser/pageStore";

/** One page's live state. Only its own events re-render the caller. */
export function useBrowserPage(id: string): PageState {
  const subscribe = useCallback((cb: () => void) => pages.subscribe(id, cb), [id]);
  const read = useCallback(() => pages.get(id), [id]);
  return useSyncExternalStore(subscribe, read);
}
