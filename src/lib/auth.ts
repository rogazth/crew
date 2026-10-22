/** Whether a turn's failure is the CLI asking for a login. */
export function isAuthFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("failed to authenticate") ||
    lower.includes("oauth session expired") ||
    lower.includes("could not be refreshed") ||
    /oauth token.*(expired|revoked)/.test(lower) ||
    lower.includes("not logged in") ||
    lower.includes("please run /login") ||
    lower.includes("login expired") ||
    // Codex: its token could not be refreshed, whatever the reason that follows.
    lower.includes("sign in again") ||
    /refresh token.*(expired|rejected|revoked|already used)/.test(lower) ||
    lower.includes("codex login") ||
    // Cursor: ACP's auth-required error, and the handshake's own line.
    lower.includes("authentication required") ||
    lower.includes("could not log in") ||
    lower.includes("cursor-agent login") ||
    // Grok: its rejected sign-in, and a refresh it could not make.
    lower.includes("grok login") ||
    lower.includes("sign-in was rejected") ||
    lower.includes("auth refresh failed")
  );
}

/**
 * What a terminal runs to sign in on the machine the session is on.
 * Null when this provider has no login of its own.
 */
export function loginArgv(provider: string, remote: boolean): string[] | null {
  // A browser on the remote machine has nowhere to finish; both ask for a code instead.
  if (remote && provider === "grok") return ["grok", "login", "--device-auth"];
  if (remote && provider === "codex") return ["codex", "login", "--device-auth"];
  switch (provider) {
    case "claude":
      return ["claude", "auth", "login"];
    case "codex":
      return ["codex", "login"];
    case "cursor":
      return ["cursor-agent", "login"];
    case "opencode":
      return ["opencode", "auth", "login"];
    case "grok":
      return ["grok", "login"];
    default:
      return null;
  }
}

/** What the session notes once a login restarted its CLI; the sign-in prompt before it is done. */
export const SIGNED_IN_NOTE = "Signed in. Send a message to continue.";
