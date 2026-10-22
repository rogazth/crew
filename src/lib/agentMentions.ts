import { fuzzyMatch } from "./fuzzy";
import type { Session } from "./types";

/**
 * `#name` names a bot or a session of the workspace, as `@path` names a file.
 * The draft keeps the name; what the agent needs to act on it, the id, goes
 * in a note under the message (`agentNote`), which the bubble leaves out.
 */
export type AgentRef = { id: string; name: string; kind: string; provider: string };

/** The mention being typed at the caret: a `#` that opens a word, and no space since. */
export function agentMentionAt(text: string, cursor: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("#");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  return { start: at, end, query };
}

/** What a session is to the agent reading the note: the word `list_peers` would use. */
export function agentKind(session: Pick<Session, "kind">): string {
  if (session.kind === "bot") return "bot";
  if (session.kind === "child") return "subagent";
  return "session";
}

/** The workspace's others, most recently active first, fuzzy-matched on name once something is typed. */
export function searchAgents(query: string, agents: readonly Session[], limit = 8): Session[] {
  const recent = [...agents].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!query) return recent.slice(0, limit);
  const hits: Array<{ agent: Session; score: number }> = [];
  for (const agent of recent) {
    const hit = fuzzyMatch(query, agent.name);
    if (hit) hits.push({ agent, score: hit.score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((hit) => hit.agent);
}

/** Replaces the mention under the caret with `#name `; returns the new text and caret. */
export function completeAgentMention(text: string, cursor: number, agent: Pick<Session, "name">) {
  const active = agentMentionAt(text, cursor);
  if (!active) return null;
  const inserted = `#${agent.name} `;
  const next = text.slice(0, active.start) + inserted + text.slice(active.end);
  return { text: next, cursor: active.start + inserted.length };
}

/** Where each `#name` of `agents` sits in `text`: the longest name wins, and it must end where a word does. */
export function agentRuns<T extends { name: string }>(text: string, agents: readonly T[]) {
  const byLength = [...agents].filter((agent) => agent.name).sort((a, b) => b.name.length - a.name.length);
  const runs: Array<{ from: number; to: number; agent: T }> = [];
  for (let at = text.indexOf("#"); at >= 0; at = text.indexOf("#", at + 1)) {
    if (at > 0 && !/\s/.test(text[at - 1]!)) continue;
    const agent = byLength.find((one) => {
      if (!text.startsWith(one.name, at + 1)) return false;
      const after = text[at + 1 + one.name.length];
      return after === undefined || !/[\p{L}\p{N}_-]/u.test(after);
    });
    if (!agent) continue;
    runs.push({ from: at, to: at + 1 + agent.name.length, agent });
    at += agent.name.length;
  }
  return runs;
}

/** The agents a draft names, in order, each once. */
export function mentionedAgents(text: string, agents: readonly Session[]): Session[] {
  const seen = new Set<string>();
  return agentRuns(text, agents)
    .map((run) => run.agent)
    .filter((agent) => !seen.has(agent.id) && seen.add(agent.id));
}

const NOTE_HEAD = "[Crew mentions: the ids of the bots and sessions named above, for read_session, send_message and delegate]";
const NOTE_LINE = /^- #(.+): (bot|session|subagent) (\S+) \(([^,)]*)/;

/** The note that goes under a message naming agents: one line each, with its id and how it is now. */
export function agentNote(agents: readonly Session[]): string {
  if (agents.length === 0) return "";
  const lines = agents.map((agent) => `- #${agent.name}: ${agentKind(agent)} ${agent.id} (${agent.provider}, ${agent.status})`);
  return `\n\n${NOTE_HEAD}\n${lines.join("\n")}`;
}

/** A sent message split into what the user wrote and the agents its note names. */
export function splitAgentNote(text: string): { body: string; agents: AgentRef[] } {
  const at = text.lastIndexOf(`\n\n${NOTE_HEAD}\n`);
  if (at < 0) return { body: text, agents: [] };
  const agents: AgentRef[] = [];
  for (const line of text.slice(at + NOTE_HEAD.length + 3).split("\n")) {
    const match = NOTE_LINE.exec(line);
    if (match) agents.push({ name: match[1]!, kind: match[2]!, id: match[3]!, provider: match[4]! });
  }
  return { body: text.slice(0, at), agents };
}
