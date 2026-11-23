/** How ⌘T reaches the blank tab on screen, which holds its field's focus while it is mounted, keyed by its pane. */
const handles = new Map<string, () => void>();

export function holdBlankTab(paneId: string, focus: () => void): () => void {
  handles.set(paneId, focus);
  return () => {
    if (handles.get(paneId) === focus) handles.delete(paneId);
  };
}

/** ⌘T on a blank tab already on screen: its field, all of it selected, so typing starts over and nothing is lost to a reflex. */
export function focusBlankTab(paneId: string) {
  handles.get(paneId)?.();
}
