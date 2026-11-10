import type { Session, Worktree } from "./types";
import { worktreeLabel } from "./worktrees";

/**
 * `@name` names a bot or a session of the workspace, or a worktree of its
 * repo; the same `@` menu reaches the files too, behind its Files row. The
 * draft keeps the name; what the agent needs to act on it, the id or the
 * path, goes in a note under the message (`agentNote`), which the bubble
 * leaves out. A worktree's ref carries its path as its id. Messages from
 * before wrote `#name`, which their bubbles still read.
 */
export type AgentRef = { id: string; name: string; kind: string; provider: string };

/** A worktree as `@` names it: by its branch, or its folder when it has none. */
export type TreeMention = { name: string; path: string };

export function treeMentions(trees: readonly Worktree[]): TreeMention[] {
  return trees.map((tree) => ({ name: worktreeLabel(tree), path: tree.path }));
}

/** What a session is to the agent reading the note: the word `list_peers` would use. */
export function agentKind(session: Pick<Session, "kind">): string {
  if (session.kind === "bot") return "bot";
  if (session.kind === "child") return "subagent";
  return "session";
}

/** The workspace's others, most recently active first, matched on name once something is typed. */
export function searchAgents(query: string, agents: readonly Session[], limit = 8): Session[] {
  const recent = [...agents].sort((a, b) => b.updatedAt - a.updatedAt);
  return matchNames(query, recent, limit);
}

/** The repo's worktrees, the main checkout first, matched on name once something is typed. */
export function searchTrees(query: string, trees: readonly TreeMention[], limit = 4): TreeMention[] {
  return matchNames(query, trees, limit);
}

/**
 * Names that answer what is typed after an `@`, as Slack's do: each word typed starts a word of the name, in
 * order, so `@a` finds `Alpha` and not `Beta`. A space typed after the last word means the name goes on past
 * it, so `@Lead ` matches no `Lead`: that name is done. Names that start with what is typed come first.
 */
function matchNames<T extends { name: string }>(query: string, items: readonly T[], limit: number): T[] {
  if (!query) return items.slice(0, limit);
  const hits = items.flatMap((item) => {
    const at = wordsMatch(query, item.name);
    return at === null ? [] : [{ item, first: at === 0 ? 0 : 1 }];
  });
  return hits
    .sort((a, b) => a.first - b.first)
    .slice(0, limit)
    .map((hit) => hit.item);
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Where the first word typed starts in the name, or null when the words do not all start words of it, in order. */
function wordsMatch(query: string, name: string): number | null {
  const hay = fold(name);
  const words = fold(query).split(/\s+/);
  const goesOn = words.at(-1) === "";
  let at = 0;
  let first: number | null = null;
  for (const word of words.filter(Boolean)) {
    let found = hay.indexOf(word, at);
    while (found > 0 && /[\p{L}\p{N}]/u.test(hay[found - 1]!)) found = hay.indexOf(word, found + 1);
    if (found < 0) return null;
    first ??= found;
    at = found + word.length;
  }
  if (goesOn && !/\s/.test(hay.slice(at))) return null;
  return first ?? 0;
}

/** The longest a name being typed may run, spaces and all, before the `@` is taken for plain text. */
const NAME_LIMIT = 60;

/**
 * The `@` being typed at the caret for the names: unlike a path, a name may have spaces, so the query runs back
 * to the last `@` that opens a word on the caret's line. Whether it is still a mention is the menu's to say (a
 * query with a space stays one while some name matches it); one that already holds a whole name, with only
 * spaces after it up to the caret, is done.
 */
export function nameMentionAt(text: string, cursor: number, names: readonly { name: string }[]) {
  if (cursor < 0) return null;
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0 || before.includes("\n", at)) return null;
  if (at > 0 && !/\s/.test(text[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > NAME_LIMIT || /^\s/.test(query)) return null;
  const whole = agentRuns(before.slice(at), names)[0];
  if (whole && whole.from === 0 && whole.to <= query.length && !/\S/.test(before.slice(at + whole.to))) return null;
  let end = cursor;
  while (end < text.length && /\S/.test(text[end]!)) end += 1;
  return { start: at, end, query };
}

/** Replaces the mention being typed with `@name `; returns the new text and caret. */
export function completeAgentMention(text: string, mention: { start: number; end: number }, agent: { name: string }) {
  const inserted = `@${agent.name} `;
  const next = text.slice(0, mention.start) + inserted + text.slice(mention.end);
  return { text: next, cursor: mention.start + inserted.length };
}

/**
 * Where each `@name` of `agents` sits in `text`: the longest name wins, and it must end where a word does.
 * `signs` are the characters that may open one: a sent message's bubble reads the old `#` too.
 */
export function agentRuns<T extends { name: string }>(text: string, agents: readonly T[], signs = "@") {
  const byLength = [...agents].filter((agent) => agent.name).sort((a, b) => b.name.length - a.name.length);
  const runs: Array<{ from: number; to: number; agent: T }> = [];
  for (let at = 0; at < text.length; at += 1) {
    if (!signs.includes(text[at]!)) continue;
    if (at > 0 && !/\s/.test(text[at - 1]!)) continue;
    const agent = byLength.find((one) => {
      if (!text.startsWith(one.name, at + 1)) return false;
      // A name that a path or a word goes on from is not this one: `@main/src` is a file's.
      const after = text.slice(at + 1 + one.name.length, at + 3 + one.name.length);
      return !/^(?:[\p{L}\p{N}_\-/]|\.[\p{L}\p{N}_])/u.test(after);
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

/** The worktrees a draft names, in order, each once; a name an agent has too stays the agent's. */
export function mentionedTrees(text: string, trees: readonly TreeMention[], agents: readonly Session[] = []): TreeMention[] {
  const seen = new Set<string>();
  const both = [...agents.map((agent) => ({ name: agent.name, tree: null })), ...trees.map((tree) => ({ name: tree.name, tree }))];
  return agentRuns(text, both)
    .flatMap((run) => (run.agent.tree ? [run.agent.tree] : []))
    .filter((tree) => !seen.has(tree.path) && seen.add(tree.path));
}

const NOTE_HEAD = "[Crew mentions: what the names above stand for: a bot's or session's id, for read_session, send_message and delegate; a worktree's path, for delegate's or start_session's worktree]";
/** The head notes had before they could name worktrees, so the bubbles of those messages still come off clean. */
const OLD_HEAD = "[Crew mentions: the ids of the bots and sessions named above, for read_session, send_message and delegate]";
const NOTE_LINE = /^- [@#](.+): (bot|session|subagent) (\S+) \(([^,)]*)/;
const TREE_LINE = /^- @(.+): worktree (.+)$/;

/** The note that goes under a message naming agents or worktrees: one line each, with its id or path. */
export function agentNote(agents: readonly Session[], trees: readonly TreeMention[] = []): string {
  if (agents.length === 0 && trees.length === 0) return "";
  const lines = [
    ...agents.map((agent) => `- @${agent.name}: ${agentKind(agent)} ${agent.id} (${agent.provider}, ${agent.status})`),
    ...trees.map((tree) => `- @${tree.name}: worktree ${tree.path}`),
  ];
  return `\n\n${NOTE_HEAD}\n${lines.join("\n")}`;
}

/** A sent message split into what the user wrote and the agents and worktrees its note names. */
export function splitAgentNote(text: string): { body: string; agents: AgentRef[] } {
  const head = [NOTE_HEAD, OLD_HEAD].find((one) => text.includes(`\n\n${one}\n`));
  if (!head) return { body: text, agents: [] };
  const at = text.lastIndexOf(`\n\n${head}\n`);
  const agents: AgentRef[] = [];
  for (const line of text.slice(at + head.length + 3).split("\n")) {
    const match = NOTE_LINE.exec(line);
    if (match) agents.push({ name: match[1]!, kind: match[2]!, id: match[3]!, provider: match[4]! });
    const tree = TREE_LINE.exec(line);
    if (tree) agents.push({ name: tree[1]!, kind: "worktree", id: tree[2]!, provider: "" });
  }
  return { body: text.slice(0, at), agents };
}
