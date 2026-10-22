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
    lower.includes("login expired")
  );
}

/**
 * What a terminal runs to sign in on the machine the session is on.
 * Null when this provider has no login of its own.
 */
export function loginArgv(provider: string, remote: boolean): string[] | null {
  if (provider === "grok" && remote) return ["grok", "login", "--device-auth"];
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
