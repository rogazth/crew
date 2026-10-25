// A sign-in in Crew's sign-in window (electron/browser/sign-in-window.ts),
// for whoever started it: the window opens the service's page, catches the
// navigation to the redirect URI, and hands the URL back here. Where it goes
// next is the caller's: a connector's to `vault_callback` on this Mac, a
// provider server's to `provider_server_callback` on the machine whose CLI
// asked. Nothing listens on the redirect URI, whichever port it names.
import { browserHost } from "./host";

/** A page to sign in on, and the redirect that ends it. */
export type SignInPage = { state: string; authUrl: string; redirectUri: string; incognito?: boolean | undefined };

/**
 * The redirect a service would send back, for where there is no sign-in
 * window (the browser-only mock): the redirect URI with a code and the state.
 */
export function mockRedirect(redirectUri: string, state: string): string {
  const join = redirectUri.includes("?") ? "&" : "?";
  return `${redirectUri}${join}code=mock&state=${encodeURIComponent(state)}`;
}

/**
 * Opens the page in a sign-in window and resolves with the redirect it
 * caught, whole, or null when the window closed first. A redirect that came
 * back with another state throws.
 */
export async function catchRedirect(page: SignInPage): Promise<string | null> {
  const host = browserHost();
  if (!host?.signIn) return mockRedirect(page.redirectUri, page.state);
  const outcome = await host.signIn({
    state: page.state,
    authUrl: page.authUrl,
    redirectUri: page.redirectUri,
    incognito: page.incognito === true,
  });
  if (outcome.kind === "caught") return outcome.url;
  if (outcome.kind === "refused") throw new Error("The sign-in came back for another request.");
  return null;
}

/** Closes a sign-in's window; its `catchRedirect` resolves null. */
export function abortSignIn(state: string): void {
  void browserHost()?.abortSignIn?.(state);
}

export type SignInEnd<T> = { kind: "done"; value: T } | { kind: "closed" };

/**
 * A whole sign-in: the window, then the caught URL to `deliver`, the daemon
 * that holds the flow. Closing the window first tells `cancel` instead. A
 * throw from either step reaches the caller, after `cancel`.
 */
export async function runSignIn<T>(
  page: SignInPage,
  to: { deliver: (url: string) => Promise<T>; cancel: () => Promise<unknown> },
): Promise<SignInEnd<T>> {
  let url: string | null;
  try {
    url = await catchRedirect(page);
  } catch (error) {
    await to.cancel().catch(() => {});
    throw error;
  }
  if (url === null) {
    await to.cancel().catch(() => {});
    return { kind: "closed" };
  }
  return { kind: "done", value: await to.deliver(url) };
}
