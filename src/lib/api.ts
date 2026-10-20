import { client } from "./client";
import { focusEnv, envOf, RAIL_ORDER } from "./client/registry";
import { open } from "./host";
import { base64OfFile, CHUNK, extensionFor, fileSource, upload } from "./upload";
import type { RoutineRow, ScheduledRoutine } from "./routines";
import type {
  BackgroundList,
  BackgroundOutput,
  BrowserLeases,
  CommandCatalog,
  CookieRead,
  CookieSource,
  DirListing,
  FileSearchResult,
  FolderEntry,
  HistoryEntry,
  HistoryList,
  ListedModel,
  LogChunk,
  MailboxDispose,
  MailboxEdit,
  MailboxReorder,
  MachineInfo,
  MachineSample,
  McpSignIn,
  McpStatus,
  MessagePage,
  PageSnapshot,
  Process,
  ProcessSpec,
  ProviderStatus,
  RemoteEnv,
  SearchFiles,
  ThreadLetter,
  ThreadMessagesRequest,
  ThreadPage,
  ThreadPair,
  TurnSendNow,
  TurnStarted,
  UsageSnapshot,
} from "./protocol";
import type { Autonomy, ProjectFile, Session, SessionKind, SessionStatus, Workspace, Worktree } from "./types";

/** Up to here a file travels in one message. */
const SINGLE_CALL = CHUNK;

/** Native picker. No filters: any document the agent can read. */
export async function pickFiles(): Promise<string[]> {
  const picked = await open({ multiple: true, directory: false });
  if (picked == null) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export const listWorkspaces = (): Promise<Workspace[]> => client.request("workspace_list");

/** Home, on this Mac: made with its folder the first time it is asked for. */
export const homeWorkspace = (): Promise<Workspace> => client.request("workspace_home");

/** `envId` is the machine the folder is on. Omitted, the folder is on this Mac. */
export const createWorkspace = (name: string, path: string, envId = "local"): Promise<Workspace> =>
  client.request("workspace_create", { name, path }, envId);

export const listWorktrees = (path: string): Promise<Worktree[]> =>
  client.request("worktree_list", { path });

/** A new worktree for `branch`, beside the repo in crew's folder; the branch is made if it does not exist. */
export const addWorktree = (path: string, branch: string): Promise<Worktree> =>
  client.request("worktree_add", { path, branch });

/**
 * Refuses the main checkout, and uncommitted work or a lock unless forced. Its sessions go with it.
 * `repo` is the workspace's checkout, where git runs when the worktree's own folder is gone.
 */
export const removeWorktree = (repo: string, path: string, force: boolean): Promise<void> =>
  client.request("worktree_remove", { path, repo, force });

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
    /** Left out, the CLI's own. */
    effort?: string;
    /** Codex's service tier. Left out, the CLI's own. */
    serviceTier?: string;
    description: string;
    autonomy: Autonomy;
    worktree?: string | null;
  },
): Promise<Session> => client.request("session_create", { workspaceId, kind, ...input });

/** The composer's chips: model, effort, service tier and access. Every window hears it as `session-updated`. */
export const setSessionOptions = (
  id: string,
  input: { model: string; effort: string; serviceTier: string; autonomy: Autonomy },
): Promise<void> => client.request("session_set_options", { id, ...input });

/** A session nobody has talked to yet moves to another provider's CLI; the daemon lets go of the one it kept. */
export const switchSessionProvider = (
  id: string,
  input: { provider: string; model: string; effort: string; serviceTier: string; autonomy: Autonomy },
): Promise<void> => client.request("session_switch_provider", { id, ...input });

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

/** How many sessions a retention of `days` would delete now. */
export const staleSessions = (days: number): Promise<number> => client.request("sessions_stale", { days });

/** Deletes them; every window hears `sessions-deleted`. */
export const expireSessions = (days: number): Promise<string[]> => client.request("sessions_expire", { days });

/** An unnamed terminal nothing was said in: closing its tab can delete it. */
export const isSessionDisposable = (id: string): Promise<boolean> =>
  client.request("session_is_disposable", { id });

export const setSessionStatus = (id: string, status: SessionStatus): Promise<void> =>
  client.request("session_set_status", { id, status });

export const markSessionRead = (id: string): Promise<void> =>
  client.request("session_mark_read", { id });

/**
 * The user has read the session up to `cursor` (its last event when left
 * out); never moves back. Answers the row; every window hears `session-updated`.
 */
export const markSessionSeen = (id: string, cursor?: number): Promise<Session | null> =>
  client.request("session_mark_seen", { id, ...(cursor === undefined ? {} : { cursor }) });

/** The pairs a session's Conversations menu lists, newest first. */
export const threadPairs = (sessionId: string): Promise<ThreadPair[]> =>
  client.request("thread_pairs", { sessionId });

/**
 * One pair's letters, both ways, oldest first. `""` or `"user"` is the user.
 * `before` is a letter id: the page ends just before it; `more` says older ones exist.
 * `sessionId` is the chat asking, which routes the call to its daemon.
 */
export const threadMessages = (params: ThreadMessagesRequest): Promise<ThreadPage> =>
  client.request("thread_messages", params);

/**
 * What waits in a session's box, and what a turn took and has not finished
 * (a claimed one may already be in the transcript: match `letterId`). The
 * window hears `mailbox-changed` when it moves.
 */
export const mailboxPending = (sessionId: string): Promise<ThreadLetter[]> =>
  client.request("mailbox_pending", { sessionId });

/**
 * The end of a background command's output: asked of the CLI while its turn
 * runs, the last read once it is gone.
 */
export const backgroundOutput = (sessionId: string, id: string): Promise<BackgroundOutput> =>
  client.request("background_output", { sessionId, id });

/** Stops one background command of a turn Crew drives. */
export const backgroundStop = (sessionId: string, id: string): Promise<void> =>
  client.request("background_stop", { sessionId, id });

/**
 * Clears a session's finished background entries from its list: the named
 * ones, or every finished one when `ids` is absent. A running one stays.
 * `hide` is the keys of the ended Crew children and process runs to leave off
 * the panel too: the daemon keeps them with the session and tells every window.
 */
export const backgroundClear = (sessionId: string, ids?: string[], hide?: string[]): Promise<void> =>
  client.request("background_clear", { sessionId, ids, hide });

/** What a session has running in the background now, fresh from the daemon. */
export const backgroundList = (sessionId: string): Promise<BackgroundList> =>
  client.request("background_list", { sessionId });

/**
 * What the user does to sign in to one of a session's MCP servers: a page for
 * the browser, or a command for a terminal tab. The provider keeps the token.
 */
export const mcpLogin = (sessionId: string, name: string): Promise<McpSignIn> =>
  client.request("mcp_login", { sessionId, name });

/** Has the session's provider connect one MCP server again. Answers the servers as they stand after. */
export const mcpReconnect = (sessionId: string, name: string): Promise<McpStatus> =>
  client.request("mcp_reconnect", { sessionId, name });

/**
 * Asks the provider to read a session's commands, skills and servers again,
 * for files that changed on disk. Answers the catalog it ends with.
 */
export const commandsReload = (sessionId: string): Promise<CommandCatalog> =>
  client.request("commands_reload", { sessionId });

/**
 * Restarts a session's CLI where it left off: the next message resumes it.
 * The daemon refuses while a turn runs, and while background work runs unless
 * `force` says it may stop with the CLI.
 */
export const sessionRestart = (sessionId: string, force = false): Promise<void> =>
  client.request("session_restart", force ? { sessionId, force } : { sessionId });

export const turnStart = (params: {
  sessionId: string;
  cwd: string;
  text: string;
  files?: unknown;
  mentions?: string[];
  command?: string;
  skills?: string[];
  hidden?: boolean;
  fresh?: boolean;
  nonce?: string;
  mode?: "auto" | "steer" | "queue";
}): Promise<TurnStarted> => client.request("turn_start", params);

/** Rewrites a message of the user's still waiting in the queue; refused once a turn took it. */
export const mailboxEdit = (params: MailboxEdit): Promise<void> => client.request("mailbox_edit", params);

/** Puts the user's waiting messages in this order, first to go first. */
export const mailboxReorder = (params: MailboxReorder): Promise<void> => client.request("mailbox_reorder", params);

/** Drops a message of the user's that still waits, unread. */
export const mailboxDispose = (params: MailboxDispose): Promise<void> => client.request("mailbox_dispose", params);

/** Stops the running turn and starts one headed by this waiting message. */
export const turnSendNow = (params: TurnSendNow): Promise<TurnStarted> => client.request("turn_send_now", params);

/** The last blocks of a transcript. `beforePos` pages towards the start. */
export const transcriptTail = (params: {
  sessionId: string;
  limit?: number;
  beforePos?: number;
}): Promise<MessagePage> => client.request("transcript_tail", params);

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

export async function reorderWorkspaces(ids: string[]): Promise<void> {
  await stateSet(RAIL_ORDER, JSON.stringify(ids));
  const localIds = ids.filter((id) => envOf(id) === "local");
  if (localIds.length > 0) await client.request("workspace_reorder", { ids: localIds });
}

export const listProjectFiles = (cwd: string): Promise<ProjectFile[]> =>
  client.request("list_project_files", { cwd });

/** One folder for the explorer: everything on disk, with what git ignores marked. */
export const listFolder = (path: string): Promise<FolderEntry[]> => client.request("list_folder", { path });

/** A newer search in the same folder cancels this one, which answers with what it had. */
export const searchFiles = (request: SearchFiles): Promise<FileSearchResult> =>
  client.request("search_files", request);

export const readTextFile = (path: string): Promise<string> =>
  client.request("read_text_file", { path });

export const writeTextFile = (path: string, contents: string): Promise<void> =>
  client.request("write_text_file", { path, contents });

export const pathExists = (path: string): Promise<boolean> => client.request("path_exists", { path });

/** True only for a file: a directory, or nothing at all, is false. */
export const pathIsFile = (path: string): Promise<boolean> => client.request("path_is_file", { path });

/** The provider's new title for the session, once adopted as its name. */
export const syncSessionTitle = (id: string): Promise<string | null> =>
  client.request("session_sync_title", { id });

/** The subset of `names` found on the user's PATH. */
export const installedBinaries = (names: string[]): Promise<string[]> =>
  client.request("agent_installed", { names });

/** The models the provider's CLI lists for this account; empty when it lists none. */
export const listedModels = (provider: string): Promise<ListedModel[]> =>
  client.request("agent_models", { provider });

export const readFileBase64 = (path: string): Promise<{ mime: string; data: string }> =>
  client.request("read_file_base64", { path });

/** Clipboard and drops have no path yet. On a remote workspace the bytes land on that machine. */
export async function writeTempFile(
  file: File,
  envId = focusEnv(),
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const extension = extensionFor(file.name, file.type);
  // A small one is a single call, which a daemon from before pieces still answers.
  if (file.size <= SINGLE_CALL) {
    signal?.throwIfAborted();
    const path = await client.request<string>(
      "write_temp_file",
      { extension, base64Contents: await base64OfFile(file) },
      envId,
    );
    onProgress?.(file.size);
    return path;
  }
  return upload(fileSource(file), envId, extension, onProgress, signal);
}

/** A new file at `path`, parent folders included. Fails rather than overwrite. */
export async function createFile(path: string, file: File): Promise<void> {
  return client.request("create_file_base64", { path, base64Contents: await base64OfFile(file) });
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

/** Browser profiles on this Mac whose cookies can be imported. */
export const browserCookieSources = (): Promise<CookieSource[]> => client.request("browser_cookie_sources", {});

/** Decrypts one profile's cookies. macOS asks for keychain access first. */
export const browserCookiesRead = (sourceId: string): Promise<CookieRead> =>
  client.request("browser_cookies_read", { sourceId });

export const browserPageSave = (pageId: string, entriesJson: string, activeIndex: number): Promise<void> =>
  client.request("browser_page_save", { pageId, entriesJson, activeIndex });

export const browserPageGet = (pageId: string): Promise<PageSnapshot | null> =>
  client.request("browser_page_get", { pageId });

export const browserPageDelete = (pageId: string): Promise<void> =>
  client.request("browser_page_delete", { pageId });

export const listProcesses = (workspaceId: string): Promise<Process[]> =>
  client.request("process_list", { workspaceId });

/** From the window, so it is the user's: it never waits for approval. */
export const createProcess = (workspaceId: string, spec: ProcessSpec): Promise<Process> =>
  client.request("process_create", { workspaceId, ...spec });

export const updateProcess = (workspaceId: string, id: string, patch: Partial<ProcessSpec>): Promise<Process> =>
  client.request("process_update", { workspaceId, id, ...patch });

/** What the window does to one run of a command: in a worktree, or the main checkout (null). */
export type RunCommand = "start" | "stop" | "restart" | "resume";

/**
 * Stop waits for the exit, which can take the whole grace period. `env` is
 * the run's own, over the command's; a restart without one keeps the last run's.
 */
export const runCommand = (
  command: RunCommand,
  workspaceId: string,
  id: string,
  worktree: string | null,
  env?: Record<string, string>,
): Promise<Process> =>
  client.request(`process_${command}`, { workspaceId, id, ...(worktree && { worktree }), ...(env && { env }) });

/** Every run stops first; the logs of all of them go too. */
export const deleteProcess = (workspaceId: string, id: string): Promise<null> =>
  client.request("process_delete", { workspaceId, id });

/** A command an agent wrote is deleted; a change it proposed is dropped. */
export const rejectProcess = (workspaceId: string, id: string): Promise<Process | null> =>
  client.request("process_reject", { workspaceId, id });

/**
 * Accepts what an agent wrote, as it stood at `revision`: the one the user
 * read. The daemon refuses it if anything changed since.
 */
export const approveProcess = (workspaceId: string, id: string, revision: number): Promise<Process> =>
  client.request("process_approve", { workspaceId, id, revision });

export const reorderProcesses = (workspaceId: string, ids: string[]): Promise<void> =>
  client.request("process_reorder", { workspaceId, ids });

/** The end of the log as written, escapes and all, for a terminal to repaint. */
export const processLogTail = (workspaceId: string, id: string, worktree: string | null): Promise<LogChunk> =>
  client.request("process_log_tail", { workspaceId, id, ...(worktree && { worktree }) });

/** Who drives which browser tab right now. */
export const browserLeasesList = (envId?: string): Promise<BrowserLeases> =>
  client.request("browser_leases_list", {}, envId);

/** The workspace of a strip: its key is the workspace id, or `<workspace>@<worktree path>`. */
const workspaceOfStrip = (context: string): string => context.split("@")[0] ?? context;

/** Takes a tab back from the agent driving it, on the daemon of the tab's workspace. */
export const browserLeaseRelease = (tab: string, context: string): Promise<void> =>
  client.request("browser_lease_release", { tab, workspaceId: workspaceOfStrip(context) });

/** The user closed a tab: its lease goes, and no agent's next call brings it back. */
export const browserTabClosed = (tab: string, context: string): Promise<void> =>
  client.request("browser_tab_closed", { tab, workspaceId: workspaceOfStrip(context) });

export const listRemotes = (): Promise<RemoteEnv[]> => client.request("remote_list");

export const upsertRemote = (env: RemoteEnv): Promise<RemoteEnv> => client.request("remote_upsert", env);

export const deleteRemoteRecord = (id: string): Promise<void> => client.request("remote_delete", { id });

export const listDir = (envId: string, path: string): Promise<DirListing> =>
  client.request("dir_list", { path }, envId);

/**
 * The agent CLIs on one machine, as that machine's daemon sees them: path,
 * version, newest release and account. `refresh` skips the daemon's caches.
 */
export const providerStatus = (envId: string, refresh = false): Promise<ProviderStatus[]> =>
  client.request("provider_status", { refresh }, envId);

export const machineInfo = (envId: string): Promise<MachineInfo> => client.request("daemon_info", {}, envId);

/** The daemon's CPU and memory samples, oldest first (about every 30 s, for about 2 h); `since` is a time in ms. */
export const machineMetrics = (envId: string, since?: number): Promise<MachineSample[]> =>
  client.request("machine_metrics", since === undefined ? {} : { since }, envId);

export { ackPty, attachPty, killPty, onPtyExit, reattachPty, resizePty, spawnPty, writePty } from "./pty";

/**
 * What each provider account on a machine has spent of its plan, and a week of
 * history. `refresh` asks the CLIs again first; `envId` names the machine
 * (the focused one by default). Two machines may report the same account:
 * `PlanUsage.account` is what to dedupe them on.
 */
export const usageRead = (refresh = false, envId?: string): Promise<UsageSnapshot> =>
  client.request("usage_read", { refresh }, envId);

/** Told with a machine's whole snapshot each time one of its readings changes (`usage-changed`). */
export const onUsageChanged = (listener: (snapshot: UsageSnapshot, envId: string) => void): (() => void) =>
  client.on("usage-changed", (payload, env) => listener(payload as UsageSnapshot, env));
