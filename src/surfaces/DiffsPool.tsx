import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { LANGS, TOKENIZE_MAX_LINE_LENGTH } from "../lib/highlighting";

type Provider = ComponentType<{
  children: ReactNode;
  poolOptions: { workerFactory: () => Worker; poolSize: number };
  highlighterOptions: { langs: typeof LANGS; useTokenTransformer: boolean; tokenizeMaxLineLength: number };
}>;

/**
 * Tokenizing on the main thread froze the window on a 14k-line composer.lock,
 * so the file editor tokenizes in a pool of workers. The pool and the shiki
 * core behind it are ~430 kB, which the window would otherwise parse before it
 * can paint, so they arrive after the first frame.
 *
 * Only `CodeView` reads this context — the chat's diffs pass `disableWorkerPool`
 * — so nothing below here is mounted yet when the provider slots in. Terminals
 * and turn chats stay outside it: appearing in the tree would remount them.
 */
export function DiffsPool({ children }: { children: ReactNode }) {
  const [pool, setPool] = useState<{ Provider: Provider; worker: () => Worker } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPool() {
      try {
        const [react, worker] = await Promise.all([
          import("@pierre/diffs/react"),
          import("@pierre/diffs/worker/worker.js?worker"),
        ]);
        if (cancelled) return;
        setPool({
          Provider: react.WorkerPoolContextProvider as Provider,
          worker: () => new worker.default(),
        });
      } catch {
        // Without the pool the editor tokenizes on the main thread, which is what
        // this replaced — worth a slow file, not a blank pane.
      }
    }
    void loadPool();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!pool) return children;
  return (
    <pool.Provider
      poolOptions={{ workerFactory: pool.worker, poolSize: 4 }}
      // The editor's own token markup: a big file it handed the pool to
      // highlight (see the @pierre/diffs patch) paints from this result.
      highlighterOptions={{ langs: LANGS, useTokenTransformer: true, tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH }}
    >
      {children}
    </pool.Provider>
  );
}
