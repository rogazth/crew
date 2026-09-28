/**
 * Installed in the page's own world before its scripts run, like the close
 * guard. On Google's sign-in the requests already go out as Firefox's
 * (identity.ts); this makes the page's scripts agree, since Chrome's client
 * hints and `window.chrome` would give the disguise away and the sign-in
 * would refuse the browser.
 *
 * The preload hands this function to `executeInMainWorld`, which copies its
 * source into the page. It must not close over imports: only its arguments
 * and globals arrive there.
 */
export function passForFirefoxOnSignIn(target?: { location: { hostname: string; protocol: string } }): boolean {
  // No argument when the preload runs it in the page. A test passes its own object.
  const scope = (target ?? globalThis) as unknown as {
    location: { hostname: string; protocol: string };
    chrome?: unknown;
    Navigator?: { prototype: object };
  };
  if (scope.location.protocol !== "https:" || scope.location.hostname !== "accounts.google.com") return false;
  const hide = (owner: object | undefined, name: string, value: unknown) => {
    if (!owner) return;
    try {
      Object.defineProperty(owner, name, { configurable: true, get: () => value });
    } catch {
      // A property the page can't redefine stays as it was.
    }
  };
  hide(scope.Navigator?.prototype, "userAgentData", undefined);
  hide(scope.Navigator?.prototype, "vendor", "");
  try {
    delete scope.chrome;
  } catch {
    // Not configurable here; the user agent and hints still say Firefox.
  }
  return true;
}
