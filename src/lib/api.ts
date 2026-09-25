import { client } from "./client";
import { open } from "./host";
import type { RoutineRow, ScheduledRoutine } from "./routines";
import type { HistoryEntry, HistoryList, MessagePage, PageSnapshot, SearchHit, SearchQuery } from "./protocol";
import type { Autonomy, ProjectFile, Session, SessionKind, SessionStatus, Workspace, Worktree } from "./types";

/** Native picker. No filters: any document the agent can read. */
export async function pickFiles(): Promise<string[]> {
  const picked = await open({ multiple: true, directory: false });
  if (picked == null) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export const listWorkspaces = (): Promise<Workspace[]> => client.request("workspace_list");

export const createWorkspace = (name: string, path: string): Promise<Workspace> =>
  client.request("workspace_create", { name, path });

export const listWorktrees = (path: string): Promise<Worktree[]> =>
  client.request("worktree_list", { path });

/** A new worktree for `branch`, beside the repo in crew's folder; the branch is made if it does not exist. */
export const addWorktree = (path: string, branch: string): Promise<Worktree> =>
  client.request("worktree_add", { path, branch });

/** Refuses the main checkout, and uncommitted work unless forced. Its sessions go with it. */
export const removeWorktree = (path: string, force: boolean): Promise<void> =>
  client.request("worktree_remove", { path, force });

export const renameWorkspace = (id: string, name: string): Promise<void> =>
  client.request("workspace_rename", { id, name });

export const deleteWorkspace = (id: string): Promise<void> =>
  client.request("workspace_delete", { id });

export const getActiveWorkspace = (): Promise<string | null> =>
  client.request("active_workspace_get");

export const setActiveWorkspace = (id: string | null): Promise<void> =>
  client.request("active_workspace_set", { id });

export const getSession = (id: string): Promise<Session | null> => client.request("session_get", { id });

export const listSessions = (workspaceId: string): Promise<Session[]> =>
  client.request("session_list", { workspaceId });

export const createSession = (
  workspaceId: string,
  kind: SessionKind,
  input: {
    name: string;
    provider: string;
    model: string;
    description: string;
    autonomy: Autonomy;
    worktree?: string | null;
  },
): Promise<Session> => client.request("session_create", { workspaceId, kind, ...input });

export const updateSession = (
  id: string,
  input: {
    name: string;
    provider: string;
    model: string;
    description: string;
    notifications: boolean;
    autonomy: Autonomy;
  },
): Promise<void> => client.request("session_update", { id, ...input });

export const renameSession = (id: string, name: string): Promise<void> =>
  client.request("session_rename", { id, name });

export const deleteSession = (id: string): Promise<void> =>
  client.request("session_delete", { id });

/** An unnamed terminal nothing was said in: closing its tab can delete it. */
export const isSessionDisposable = (id: string): Promise<boolean> =>
  client.request("session_is_disposable", { id });

export const setSessionStatus = (id: string, status: SessionStatus): Promise<void> =>
  client.request("session_set_status", { id, status });

export const markSessionRead = (id: string): Promise<void> =>
  client.request("session_mark_read", { id });

export const turnStart = (params: {
  sessionId: string;
  cwd: string;
  text: string;
  files?: unknown;
  mentions?: string[];
  hidden?: boolean;
  fresh?: boolean;
  nonce?: string;
}): Promise<{ working: boolean }> => client.request("turn_start", params);

/** The last blocks of a transcript. `beforePos` pages towards the start. */
export const transcriptTail = (params: {
  sessionId: string;
  limit?: number;
  beforePos?: number;
}): Promise<MessagePage> => client.request("transcript_tail", params);

export const searchMessages = (query: SearchQuery): Promise<SearchHit[]> =>
  client.request("messages_search", query);

export const turnStop = (sessionId: string): Promise<void> =>
  client.request("turn_stop", { sessionId });

export const turnRespond = (
  sessionId: string,
  requestId: number,
  decision: "allow" | "always" | "deny",
): Promise<void> => client.request("turn_respond", { sessionId, requestId, decision });

export const turnAnswer = (
  sessionId: string,
  requestId: number,
  answers: { [key in string]: string } | null,
): Promise<void> => client.request("turn_answer", { sessionId, requestId, answers });

export const listSessionRoutines = (sessionId: string): Promise<RoutineRow[]> =>
  client.request("routine_list_for_session", { sessionId });

export const listRoutines = (): Promise<ScheduledRoutine[]> => client.request("routine_list");

/** Fire one routine now. The daemon runs it exactly as it runs a due one. */
export const runRoutineNow = (routineId: string): Promise<void> =>
  client.request("routine_run_now", { routineId });

export const upsertRoutine = (input: {
  id?: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: string;
  nextRunAt: number | null;
  createdBy?: string;
}): Promise<RoutineRow> => client.request("routine_upsert", { id: null, ...input });

export const deleteRoutine = (id: string): Promise<void> => client.request("routine_delete", { id });



export const stateGet = (key: string): Promise<string | null> => client.request("state_get", { key });

export const stateSet = (key: string, value: string): Promise<void> =>
  client.request("state_set", { key, value });

export const stateDelete = (key: string): Promise<void> => client.request("state_delete", { key });

export const reorderSessions = (ids: string[]): Promise<void> =>
  client.request("session_reorder", { ids });

export const reorderWorkspaces = (ids: string[]): Promise<void> =>
  client.request("workspace_reorder", { ids });

export const listProjectFiles = (cwd: string, include: string[] = []): Promise<ProjectFile[]> =>
  client.request("list_project_files", { cwd, include });

export const readTextFile = (path: string): Promise<string> =>
  client.request("read_text_file", { path });

export const writeTextFile = (path: string, contents: string): Promise<void> =>
  client.request("write_text_file", { path, contents });

export const pathExists = (path: string): Promise<boolean> => client.request("path_exists", { path });

/** The name Claude Code gave the session behind this transcript, if it named it. */
/** The provider's new title for the session, once adopted as its name. */
export const syncSessionTitle = (id: string): Promise<string | null> =>
  client.request("session_sync_title", { id });

/** The subset of `names` found on the user's PATH. */
export const installedBinaries = (names: string[]): Promise<string[]> =>
  client.request("agent_installed", { names });

/** cursor-agent: a chat created and bound before the terminal starts. */
export const createProviderSession = (id: string): Promise<string> =>
  client.request("session_provider_create", { id });

/** codex, opencode: the session they started in `cwd` since `since`, bound once found. */
/** Claude's new session id when `/clear` moved it since the last look. */
export const rebindClaudeSession = (id: string): Promise<string | null> =>
  client.request("session_claude_rebind", { id });

/** What Claude asked of you since the last look, when it stopped to ask. */
export const claudeAttention = (id: string): Promise<string | null> =>
  client.request("session_claude_attention", { id });

export const discoverProviderSession = (id: string, cwd: string, since: number): Promise<string | null> =>
  client.request("session_provider_discover", { id, cwd, since });

export const readFileBase64 = (path: string): Promise<{ mime: string; data: string }> =>
  client.request("read_file_base64", { path });

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // fromCharCode takes the array as arguments, so a whole screenshot blows the stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Clipboard files have no path; the CLIs Crew hosts only take paths. */
export async function writeTempFile(file: File): Promise<string> {
  const extension = file.type.split("/")[1] ?? file.name.split(".").pop() ?? "bin";
  return client.request("write_temp_file", { extension, base64Contents: await base64Of(file) });
}

/** A new file at `path`, parent folders included. Fails rather than overwrite. */
export async function createFile(path: string, file: File): Promise<void> {
  return client.request("create_file_base64", { path, base64Contents: await base64Of(file) });
}

/** A committed main-frame navigation. The daemon drops anything that is not http(s). */
export const browserHistoryVisit = (url: string, title: string, workspaceId?: string): Promise<void> =>
  client.request("browser_history_visit", { url, title, workspaceId });

/** A title that arrived after its visit. It never counts as one. */
export const browserHistoryTitle = (url: string, title: string): Promise<void> =>
  client.request("browser_history_title", { url, title });

/** Address-bar suggestions, best first. Empty text answers the most recent. */
export const browserHistorySuggest = (text: string, limit: number): Promise<HistoryEntry[]> =>
  client.request("browser_history_suggest", { text, limit });

/** The History page, newest first. `before` is the last shown row's `lastVisitedAt`. */
export const browserHistoryList = (params: HistoryList): Promise<HistoryEntry[]> =>
  client.request("browser_history_list", params);

export const browserHistoryDelete = (urlKey: string): Promise<void> =>
  client.request("browser_history_delete", { urlKey });

/** `since` clears from that moment on; without it, everything goes. */
export const browserHistoryClear = (since?: number): Promise<void> =>
  client.request("browser_history_clear", { since });

export const browserPageSave = (pageId: string, entriesJson: string, activeIndex: number): Promise<void> =>
  client.request("browser_page_save", { pageId, entriesJson, activeIndex });

export const browserPageGet = (pageId: string): Promise<PageSnapshot | null> =>
  client.request("browser_page_get", { pageId });

export const browserPageDelete = (pageId: string): Promise<void> =>
  client.request("browser_page_delete", { pageId });

export { ackPty, killPty, resizePty, spawnPty, writePty } from "./pty";
