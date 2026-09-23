import { attachedFrom } from "./attachments";
import type { AttachedFile } from "./blocks";
import { mentionedFiles } from "./mentions";
import { isAgentTab, type Pane } from "./tabs";
import type { ProjectFile, Session, Tab } from "./types";

/** The strip after adding `paths`: new ones at the end, none twice. */
export function addAttachments(prev: AttachedFile[], paths: string[]): AttachedFile[] {
  const seen = new Set(prev.map((file) => file.path));
  const next: AttachedFile[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    next.push(attachedFrom(path));
  }
  return [...prev, ...next];
}

/** Pasted files written to temp paths; the ones that failed to write are dropped. */
export async function pastedPaths(files: File[], write: (file: File) => Promise<string>): Promise<string[]> {
  const paths = await Promise.all(files.map((file) => write(file).catch(() => null)));
  return paths.filter((path): path is string => path !== null);
}

export type Outgoing = { text: string; files: AttachedFile[]; options: { mentions?: string[] } };

/** What Send hands the runtime, or null while there is nothing to send or nobody to take it. */
export function outgoing(
  draft: string,
  files: AttachedFile[],
  projectFiles: ProjectFile[],
  working: boolean,
  ready: boolean,
): Outgoing | null {
  const text = draft.trim();
  if ((!text && files.length === 0) || working || !ready) return null;
  const mentions = mentionedFiles(text, projectFiles).map((file) => file.path);
  return { text, files, options: mentions.length > 0 ? { mentions } : {} };
}

/** The agent session a tab shows, if it shows one. */
export function agentSessionOf(tab: Tab, sessions: Session[]): Session | null {
  if (tab.kind !== "session" || !isAgentTab(tab, sessions)) return null;
  return sessions.find((row) => row.id === tab.sessionId) ?? null;
}

/** The agent chat on screen: its turns end quiet instead of flagged. */
export function foregroundAgent(panes: Pick<Pane, "tab" | "visible">[], sessions: Session[]): string | null {
  const shown = panes.find((pane) => pane.visible);
  return shown ? (agentSessionOf(shown.tab, sessions)?.id ?? null) : null;
}
