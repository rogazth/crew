/**
 * Models name an agent however they like. `list_agents` hands them ids, so a
 * `message_agent` row often carries a uuid where the reader wants a name — and
 * the row is the whole point of showing the call. The session list knows both
 * sides; this is where the chat looks one up.
 */
const names = new Map<string, string>();

/** Every session the app has loaded. Anything not in it is left as it came. */
export function rememberAgents(sessions: readonly { id: string; name: string }[]): void {
  for (const session of sessions) names.set(session.id, session.name);
}

/** The name behind an id, or the string itself when it is already a name. */
export function agentLabel(idOrName: string): string {
  return names.get(idOrName) ?? idOrName;
}
