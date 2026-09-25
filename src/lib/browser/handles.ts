/** What a mounted page answers to from outside its pane: the browser commands and the history page. */
export type PaneHandle = {
  back(): void;
  forward(): void;
  reload(): void;
  /** Reloads past the cache, the way ⌘⇧R does in a browser. */
  hardReload(): void;
  focusAddress(): void;
  toggleDevTools(): void;
  navigate(url: string): void;
  find(): void;
  /** -1 out, 1 in, 0 back to actual size. */
  zoom(direction: -1 | 0 | 1): void;
};

const handles = new Map<string, PaneHandle>();

/** A page holds its handle while mounted, keyed by its tab id. */
export function holdPane(pageId: string, handle: PaneHandle): () => void {
  handles.set(pageId, handle);
  return () => {
    if (handles.get(pageId) === handle) handles.delete(pageId);
  };
}

export function paneHandle(pageId: string): PaneHandle | undefined {
  return handles.get(pageId);
}
