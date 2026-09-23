/** What a mounted page answers to from outside its pane: the browser commands and the history page. */
export type PaneHandle = {
  back(): void;
  forward(): void;
  reload(): void;
  focusAddress(): void;
  toggleDevTools(): void;
  navigate(url: string): void;
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
