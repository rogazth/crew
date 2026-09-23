export type LoadError = { code: number; description: string; url: string };

const ERR_ABORTED = -3;

/** `did-fail-load` as the page should see it, or null when there is nothing to show. */
export function classifyLoadFailure(
  e: { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean },
  fallbackUrl: string,
): LoadError | null {
  if (!e.isMainFrame) return null;
  // Chromium reports ERR_ABORTED for redirect and cancel races even when the
  // navigation that replaced it succeeds.
  if (e.errorCode === ERR_ABORTED || e.errorCode === 0) return null;
  return {
    code: e.errorCode,
    description: e.errorDescription || "Unknown error",
    url: e.validatedURL || fallbackUrl,
  };
}

/** Chromium's net error codes, in words. */
export function describeLoadError(code: number): { title: string; detail: string } {
  switch (code) {
    case -102:
      return {
        title: "Connection refused.",
        detail: "Nothing is listening at this address. If it's a dev server, start it and try again.",
      };
    case -105:
      return { title: "Address not found.", detail: "The host name didn't resolve. Check the spelling." };
    case -106:
      return { title: "No internet connection.", detail: "Reconnect and try again." };
    case -118:
      return { title: "Timed out.", detail: "The server took too long to respond." };
    case -109:
      return { title: "Address unreachable.", detail: "There's no route to this host from your network." };
    case -100:
      return { title: "Connection closed.", detail: "The server closed the connection before it answered." };
    case -101:
      return { title: "Connection reset.", detail: "The connection dropped before the page loaded." };
    case -310:
      return { title: "Too many redirects.", detail: "The page keeps redirecting and never lands." };
    case -324:
      return { title: "Empty response.", detail: "The server closed the connection without sending anything." };
  }
  if (code <= -200 && code >= -299) {
    return {
      title: "Certificate problem.",
      detail: "The site's certificate can't be trusted, so the page wasn't loaded.",
    };
  }
  return { title: "The page didn't load.", detail: `Error ${code}.` };
}
