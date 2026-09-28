import type { PagePrompt } from "./bridge";

/**
 * What each page is waiting on the person for, by the page's webContents id,
 * oldest first. Only the first one of a page is shown; the rest wait behind it.
 */
export type PromptStore = {
  forPage(webContentsId: number | null): readonly PagePrompt[];
  add(prompt: PagePrompt): void;
  remove(id: string): void;
  subscribe(cb: () => void): () => void;
};

const NONE: readonly PagePrompt[] = Object.freeze([]);

export function createPromptStore(): PromptStore {
  // Each page's list is replaced, never changed in place, so a reader sees a new array only when its page changed.
  let byPage = new Map<number, readonly PagePrompt[]>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const cb of [...listeners]) cb();
  };
  return {
    forPage: (webContentsId) => (webContentsId === null ? NONE : (byPage.get(webContentsId) ?? NONE)),
    add(prompt) {
      const current = byPage.get(prompt.webContentsId) ?? NONE;
      if (current.some((item) => item.id === prompt.id)) return;
      byPage = new Map(byPage).set(prompt.webContentsId, [...current, prompt]);
      emit();
    },
    remove(id) {
      for (const [page, list] of byPage) {
        if (!list.some((item) => item.id === id)) continue;
        const rest = list.filter((item) => item.id !== id);
        byPage = new Map(byPage);
        if (rest.length > 0) byPage.set(page, rest);
        else byPage.delete(page);
        emit();
        return;
      }
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export const prompts: PromptStore = createPromptStore();
