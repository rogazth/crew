import { useCallback, useSyncExternalStore } from "react";
import { mcpReconnect } from "./api";
import { client } from "./client";
import type { McpChanged, McpServer, McpState, McpStatus } from "./protocol";
import { announceSignIn } from "./turnRuntime";

/**
 * Which MCP servers each session has and how they stand (plan decision 20):
 * the chip by the context meter and the sheet it opens. The daemon pushes
 * `mcp-changed`; this keeps the latest per session, read the first time a view
 * asks.
 */

type Listener = () => void;

const statuses = new Map<string, McpStatus>();
/** Bumped by every status heard: a read that went out before one is older than it. */
const heard = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("mcp-changed", (payload) => {
    const change = payload as McpChanged;
    // Only a push is news: a status read on opening a window is not.
    const news = newlyNeedingSignIn(statuses.get(change.sessionId), change.status);
    set(change.sessionId, change.status);
    announceSignIn(change.sessionId, news);
  });
  client.onReconnect((here = () => true) => {
    for (const id of listeners.keys()) if (here(id)) void fetchStatus(id);
  });
}

function set(id: string, status: McpStatus) {
  heard.set(id, (heard.get(id) ?? 0) + 1);
  statuses.set(id, status);
  for (const listener of listeners.get(id) ?? []) listener();
}

async function fetchStatus(id: string): Promise<void> {
  const before = heard.get(id) ?? 0;
  try {
    const status = await client.request<McpStatus>("mcp_list", { sessionId: id });
    if ((heard.get(id) ?? 0) === before) set(id, status);
  } catch {
    // A crewd that predates MCP status has nothing to list.
  }
}

export function subscribeMcp(id: string, listener: Listener): () => void {
  ensureBridge();
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
    void fetchStatus(id);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

export function readMcp(id: string): McpStatus | null {
  return statuses.get(id) ?? null;
}

/** A session's MCP servers as the daemon last said; null until it has. */
export function useMcp(sessionId: string): McpStatus | null {
  const subscribe = useCallback((listener: () => void) => subscribeMcp(sessionId, listener), [sessionId]);
  return useSyncExternalStore(subscribe, () => readMcp(sessionId));
}

// ——— What the views derive ————————————————————————————————————————————————

const count = (status: McpStatus | null | undefined, state: McpState) =>
  status?.servers.filter((server) => server.state === state).length ?? 0;

/**
 * What the chip says, or null when there is nothing to say: a server that
 * waits for a sign-in, one that failed. Connecting and disabled servers are
 * not news.
 */
export function chipLabel(status: McpStatus | null | undefined): string | null {
  const parts: string[] = [];
  const auth = count(status, "needs_auth");
  const failed = count(status, "failed");
  if (auth > 0) parts.push(`${auth} ${auth === 1 ? "needs" : "need"} sign-in`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The names that wait for a sign-in in `next` and did not in `last`. */
export function newlyNeedingSignIn(last: McpStatus | undefined, next: McpStatus): string[] {
  const before = new Set(last?.servers.filter((server) => server.state === "needs_auth").map((server) => server.name));
  return next.servers.filter((server) => server.state === "needs_auth" && !before.has(server.name)).map((server) => server.name);
}

/** The state as a row says it. */
export function stateLabel(server: McpServer): string {
  switch (server.state) {
    case "connected":
      return "Connected";
    case "pending":
      return "Connecting";
    case "failed":
      return server.error ? `Failed: ${server.error}` : "Failed";
    case "needs_auth":
      return server.error ? `Needs sign-in: ${server.error}` : "Needs sign-in";
    case "disabled":
      return "Disabled";
    case "unknown":
      return "Unknown";
  }
}

/** What a row offers: a login for a server that needs one, a new try for one that failed. */
export function actionOf(server: McpServer): "sign-in" | "reconnect" | null {
  if (server.state === "needs_auth") return "sign-in";
  if (server.state === "failed") return "reconnect";
  return null;
}

/**
 * Rows in the order the user has to act on them: the sign-ins, then the
 * failures, then the rest in the order the provider listed them.
 */
export function sortedServers(status: McpStatus | null | undefined): McpServer[] {
  const rank = (server: McpServer) => (server.state === "needs_auth" ? 0 : server.state === "failed" ? 1 : 2);
  return (status?.servers ?? []).map((server, at) => ({ server, at })).sort((a, b) => rank(a.server) - rank(b.server) || a.at - b.at).map(({ server }) => server);
}

/** The line a session whose provider does not report its servers shows where its servers would be. */
export function unreportedNote(status: McpStatus | null | undefined, provider: string): string | null {
  if (!status || status.reported) return null;
  return `${provider} does not report its servers`;
}

const reconnected = new Set<string>();

/**
 * A sign-in terminal ended: the session connects the server again. A tab's
 * shell can exit after the login did, which is not another sign-in, so each
 * tab asks once.
 */
export async function reconnectAfterSignIn(tabId: string, sessionId: string, server: string): Promise<void> {
  if (reconnected.has(tabId)) return;
  reconnected.add(tabId);
  try {
    set(sessionId, await mcpReconnect(sessionId, server));
  } catch {
    // The status the daemon pushes after the attempt says how it ended.
  }
}
