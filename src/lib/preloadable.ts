import { lazy, type ComponentType } from "react";

/**
 * `React.lazy`, with `preload` to fetch the module before it is needed. A lazy
 * component that suspends holds its Suspense boundary for React's 300 ms
 * reveal throttle, however fast its chunk arrives: a terminal or a file tab
 * opened for the first time sat blank that long. One whose module is already
 * in hand renders on its first pass instead.
 */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: { default: ComponentType<P> } | undefined;
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  const preload = () =>
    (pending ??= load().then(
      (component) => (loaded = { default: component }),
      (error: unknown) => {
        // A failed fetch is tried again by the next preload or render.
        pending = undefined;
        throw error;
      },
    ));
  const Component = lazy(() => {
    const module = loaded;
    // A thenable that answers as `then` is called: React reads the module as
    // resolved on the same pass, before it would suspend.
    if (module) return { then: (resolve: (value: typeof module) => void) => resolve(module) } as Promise<typeof module>;
    return preload();
  });
  return { Component, preload };
}

/** Runs each preload once the window is idle; the cleanup cancels what has not started. */
export function preloadWhenIdle(...preloads: (() => Promise<unknown>)[]): () => void {
  const idle = requestIdleCallback(
    () => {
      for (const preload of preloads) void preload().catch(() => {});
    },
    { timeout: 5_000 },
  );
  return () => cancelIdleCallback(idle);
}
