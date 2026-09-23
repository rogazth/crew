import type { CommandId } from "./commands";
import { fuzzyMatch } from "./fuzzy";
import type { ProjectFile, Session, Workspace } from "./types";

export type PaletteMode = "all" | "agents" | "sessions" | "files" | "actions";

export const PALETTE_MODES: { id: PaletteMode; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "files", label: "Files" },
  { id: "actions", label: "Actions" },
];

export const FILE_LIMIT = 50;

export type PaletteItem =
  | { key: string; kind: "session"; session: Session }
  | { key: string; kind: "file"; file: ProjectFile }
  | { key: string; kind: "action"; id: CommandId; label: string; keys: string }
  | { key: string; kind: "workspace"; workspace: Workspace };

export type PaletteGroup = { label: string; items: PaletteItem[] };

/** A leading `>` shows Actions whatever the filter, and is not part of the query. */
export function readQuery(raw: string, mode: PaletteMode): { query: string; shown: PaletteMode } {
  return raw.startsWith(">") ? { query: raw.slice(1), shown: "actions" } : { query: raw, shown: mode };
}

/** The filter ⇥ (delta 1) or ⇧⇥ (delta -1) lands on, wrapping at both ends. */
export function stepMode(mode: PaletteMode, delta: number): PaletteMode {
  const at = PALETTE_MODES.findIndex((entry) => entry.id === mode);
  return PALETTE_MODES[(at + delta + PALETTE_MODES.length) % PALETTE_MODES.length]!.id;
}

/** Live commands, then a switch to every workspace but the one on screen. */
export function paletteActions(
  commands: { id: CommandId; label: string; keys: string }[],
  workspaces: Workspace[],
  activeWorkspaceId: string,
): PaletteItem[] {
  const items = commands.map((command): PaletteItem => ({ key: `action:${command.id}`, kind: "action", ...command }));
  const switches = workspaces.flatMap((workspace): PaletteItem[] =>
    workspace.id === activeWorkspaceId ? [] : [{ key: `ws:${workspace.id}`, kind: "workspace", workspace }],
  );
  return [...items, ...switches];
}

export function paletteGroups({
  shown,
  query,
  sessions,
  files,
  actions,
}: {
  shown: PaletteMode;
  query: string;
  sessions: Session[];
  files: ProjectFile[];
  actions: PaletteItem[];
}): PaletteGroup[] {
  const agents = sessions.filter((session) => session.kind === "agent");
  const terminals = sessions.filter((session) => session.kind === "terminal");
  const asItem = (session: Session): PaletteItem => ({ key: `session:${session.id}`, kind: "session", session });
  const fileItems = () => files.map((file): PaletteItem => ({ key: `file:${file.path}`, kind: "file", file }));

  if (shown === "agents") return [group("Agents", rankItems(agents.map(asItem), query))];
  if (shown === "sessions") return [group("Sessions", rankItems(terminals.map(asItem), query))];
  if (shown === "actions") return [group("Actions", rankItems(actions, query))];
  if (shown === "files") return [group("Files", rankItems(fileItems(), query).slice(0, FILE_LIMIT))];

  // An empty All is the cold-open case: offer what was touched last, not the whole workspace.
  if (!query.trim()) {
    const recent = [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
      .map(asItem);
    return [group("Recent", recent), group("Actions", actions.slice(0, 5))];
  }

  return [
    group("Agents", rankItems(agents.map(asItem), query)),
    group("Sessions", rankItems(terminals.map(asItem), query)),
    group("Files", rankItems(fileItems(), query).slice(0, 10)),
    group("Actions", rankItems(actions, query)),
  ];
}

/** Where each group's first row sits in the flat, keyboard-navigable list. */
export function groupStarts(groups: PaletteGroup[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const entry of groups) {
    starts.push(at);
    at += entry.items.length;
  }
  return starts;
}

function group(label: string, items: PaletteItem[]): PaletteGroup {
  return { label, items };
}

/** Best fuzzy match first; items that do not match drop out. An empty query keeps the input order. */
export function rankItems(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items;
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const hit = fuzzyMatch(query, searchText(item));
    if (hit) scored.push({ item, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

export function searchText(item: PaletteItem): string {
  if (item.kind === "file") return item.file.relative;
  if (item.kind === "session") return item.session.name;
  if (item.kind === "workspace") return item.workspace.name;
  return item.label;
}

/** What a row reads: its label, and the quieter detail beside it. */
export function itemFace(item: PaletteItem): { label: string; detail?: string } {
  if (item.kind === "file") return { label: item.file.name, detail: item.file.relative };
  if (item.kind === "session") return { label: item.session.name, detail: item.session.provider };
  if (item.kind === "workspace") return { label: `Switch to ${item.workspace.name}`, detail: item.workspace.path };
  return { label: item.label };
}
