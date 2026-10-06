/** The window's own daemon. Remote ids are the ones stored beside it. */
export const LOCAL = "local";

export type RouteMaps = {
  workspace: ReadonlyMap<string, string>;
  session: ReadonlyMap<string, string>;
  /** Workspace and worktree directories, longest prefix wins. */
  path: ReadonlyMap<string, string>;
  routine: ReadonlyMap<string, string>;
};

/**
 * Calls that always belong to this Mac: its preferences, its browser, and the
 * address book of remotes. A workspace's sessions, files and terminals follow
 * the daemon that holds that workspace.
 */
const LOCAL_METHODS = new Set([
  "state_get",
  "state_set",
  "state_delete",
  "active_workspace_get",
  "active_workspace_set",
  "workspace_reorder",
  "workspace_home",
  "messages_search",
  "remote_list",
  "remote_upsert",
  "remote_delete",
  "browser_history_visit",
  "browser_history_title",
  "browser_history_suggest",
  "browser_history_list",
  "browser_history_delete",
  "browser_history_clear",
  "browser_cookie_sources",
  "browser_cookies_read",
  "browser_page_save",
  "browser_page_get",
  "browser_page_delete",
]);

/** Calls about "the machine in front of you": the focused workspace's. */
const FOCUS_METHODS = new Set(["agent_installed", "agent_models", "write_temp_file"]);

function text(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The daemon a call belongs to. `explicit` is a machine the caller already
 * chose; `focus` is the focused workspace's, the answer for a path no known
 * workspace holds (a terminal link to /etc/hosts on the machine in front).
 */
export function routeEnv(
  method: string,
  params: Record<string, unknown>,
  maps: RouteMaps,
  explicit?: string,
  focus: string = LOCAL,
): string {
  if (explicit) return explicit;
  if (LOCAL_METHODS.has(method)) return LOCAL;
  if (FOCUS_METHODS.has(method)) return focus;

  const workspaceId = text(params, "workspaceId");
  if (workspaceId && maps.workspace.has(workspaceId)) return maps.workspace.get(workspaceId) ?? LOCAL;

  const sessionId = text(params, "sessionId");
  if (sessionId && maps.session.has(sessionId)) return maps.session.get(sessionId) ?? LOCAL;

  const routineId = text(params, "routineId");
  if (routineId && maps.routine.has(routineId)) return maps.routine.get(routineId) ?? LOCAL;

  const id = text(params, "id");
  if (id && maps.session.has(id)) return maps.session.get(id) ?? LOCAL;
  if (id && maps.workspace.has(id)) return maps.workspace.get(id) ?? LOCAL;
  if (id && maps.routine.has(id)) return maps.routine.get(id) ?? LOCAL;
  const pane = id && method.startsWith("pty_") ? envForPane(id, maps) : null;
  if (pane) return pane;

  if (method === "session_reorder" && Array.isArray(params.ids)) {
    const first = params.ids.find((item) => typeof item === "string");
    if (typeof first === "string" && maps.session.has(first)) return maps.session.get(first) ?? LOCAL;
  }

  const path = text(params, "path") ?? text(params, "cwd");
  if (path) return envForPath(path, maps.path) ?? focus;
  return LOCAL;
}

/**
 * The environment of a terminal's PTY. Its id is the pane's, or for a
 * session's terminal, the session's: `<workspace>[@<worktree>]/session:<session>`.
 */
export function envForPane(id: string, maps: Pick<RouteMaps, "session" | "workspace">): string | null {
  const direct = maps.session.get(id);
  if (direct) return direct;
  const at = id.lastIndexOf("session:");
  const session = at >= 0 ? maps.session.get(id.slice(at + "session:".length)) : undefined;
  if (session) return session;
  const workspace = id.split("/")[0]?.split("@")[0];
  return (workspace && maps.workspace.get(workspace)) || null;
}

/** The environment whose directory contains `path`, the longest one when several do. */
export function envForPath(path: string, paths: ReadonlyMap<string, string>): string | null {
  let best: string | null = null;
  let length = -1;
  for (const [root, env] of paths) {
    if (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)) {
      if (root.length > length) {
        best = env;
        length = root.length;
      }
    }
  }
  return best;
}
