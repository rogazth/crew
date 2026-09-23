/**
 * Installed in the page's own world, before its scripts run. Electron destroys
 * a webview guest when the page calls `window.close()`, and nothing listening
 * for `close` can stop that. A tab is not a window: the call has to do nothing.
 * A real popup is a BrowserWindow and does not get this, so it can still close.
 *
 * The preload hands this function to `executeInMainWorld`, which copies its
 * source into the page. It must not close over imports: only its arguments
 * and globals arrive there.
 */
export function ignoreWindowClose(target?: { close: () => void }): void {
  // No argument when the preload runs it in the page. A test passes its own object.
  const host = target ?? (globalThis as { close: () => void });
  const ignore = (): void => {};
  try {
    Object.defineProperty(host, "close", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: ignore,
    });
  } catch {
    try {
      host.close = ignore;
    } catch {
      // The page locked `close` already. Nothing else to do from here.
    }
  }
}
