import { createContext, useContext } from "react";
import type { Party, ThreadRef } from "../../lib/letters";
import type { PanelEntry } from "../../lib/backgroundPanel";
import type { Process } from "../../lib/processes";
import type { BackgroundCommand } from "../../lib/protocol";
import type { Ask } from "../../lib/turnRuntime";
import type { ProjectFile, Session } from "../../lib/types";

/** What a chat surface can ask of the shell without a prop for every level. */
export type ChatActions = {
  /** Workspace-relative or absolute; opens a file tab. */
  openPath: (path: string) => void;
  /** Shows a folder (workspace-relative or absolute) in the explorer, opened. */
  openFolder: (path: string) => void;
  /** Where a path a reply names sits on the session's machine: absolute, or null with no folder to read it from. */
  resolvePath: (path: string) => string | null;
  /** Opens a bot's tab: the name on a message from one is a link. */
  openSession: (sessionId: string) => void;
  /**
   * Opens an agent's thread in place, over the chat that holds it: an entry id
   * of the chat's work (`session:<id>`, `command:<id>`) or a session id.
   * `focus` is a letter id the thread opens scrolled to.
   */
  openAgent: (target: string, options?: { focus?: string }) => void;
  /** The workspace index, for `@` mentions. */
  files: ProjectFile[];
  /** The workspace's commands, whose runs a session started are in its background panel. */
  processes: readonly Process[];
  /** A command's run in a tab of its worktree's strip. */
  openProcessRun: (process: Process, worktree: string | null) => void;
  /** Runs an MCP server's login for a session in a terminal tab; its end has the session connect the server. */
  openSignIn: (sessionId: string, server: string, command: string[]) => void;
  /** Runs the provider's own login in a terminal tab; a clean exit restarts the session's CLI. */
  openLogin: (sessionId: string, provider: string, command: string[]) => void;
  /** Asks the shell's dialog before something that costs the session work: a restart over running background work. */
  confirm: Ask;
};

export const ChatContext = createContext<ChatActions>({
  openPath: () => undefined,
  openFolder: () => undefined,
  resolvePath: () => null,
  openSession: () => undefined,
  openAgent: () => undefined,
  files: [],
  processes: [],
  openProcessRun: () => undefined,
  openSignIn: () => undefined,
  openLogin: () => undefined,
  confirm: () => undefined,
});

/** The session whose chat is on screen, so a note in it can ask that session to sign in. */
export type ChatSession = { id: string; provider: string };

export const ChatSessionContext = createContext<ChatSession | null>(null);

export function useChatSession(): ChatSession | null {
  return useContext(ChatSessionContext);
}

export function useChatActions(): ChatActions {
  return useContext(ChatContext);
}

/**
 * Whether an approval can take "don't ask again". A turn Crew drives always can;
 * a CLI's own prompt offers it only when it has a rule to suggest.
 */
export const AlwaysAllow = createContext(true);

/**
 * The chat a checkpoint is drawn in: whose it is (`owner`), the sessions a
 * letter's parties are looked up in, and the way into a pair's thread. No
 * owner, no checkpoints: a chat without one draws letters as it always did.
 */
export type LetterScope = {
  owner: Party | null;
  sessions: readonly Session[];
  openThread: (thread: ThreadRef) => void;
};

export const LetterContext = createContext<LetterScope>({ owner: null, sessions: [], openThread: () => undefined });

export function useLetterScope(): LetterScope {
  return useContext(LetterContext);
}

/**
 * The chat's work, the one list its status line and sheet read: the cards in
 * the transcript for a subagent or a session started say what the sheet says.
 */
export const WorkContext = createContext<readonly PanelEntry[]>([]);

/**
 * The background commands a chat's transcript marks, by the tool call that
 * started each, and the way into one's page in the background panel. Empty:
 * no markers, the calls draw as the tool rows they are.
 */
export type BackgroundScope = {
  calls: ReadonlyMap<string, BackgroundCommand>;
  open: (id: string) => void;
};

export const BackgroundContext = createContext<BackgroundScope>({ calls: new Map(), open: () => undefined });

export function useBackgroundScope(): BackgroundScope {
  return useContext(BackgroundContext);
}
