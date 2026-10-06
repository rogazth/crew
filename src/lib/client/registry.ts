import { daemonInfo, remotesHost } from "../host";
import { dispatchNotification } from "../notifications";
import type { MachineInfo, RemoteEnv, Workspace } from "../protocol";
import { RETENTION_KEY } from "../retention";
import { Connection, EnvDown, type ConnStatus } from "./connection";
import { LOCAL, envForPane, envForPath, routeEnv, type RouteMaps } from "./route";

export { LOCAL, EnvDown };
export type { ConnStatus };
export const RAIL_ORDER = "rail_order";

/** What the window knows about one daemon, this Mac's included. */
export type EnvLink = {
  id: string;
  name: string;
  status: ConnStatus;
  /** Why the last attempt failed. Null while online. */
  error: string | null;
  latency: number | null;
  mismatch: boolean;
  version: string | null;
  home: string | null;
  socksPort: number | null;
  host: string | null;
  user: string | null;
  port: number | null;
  /** What ssh is given for it: a Host from ~/.ssh/config, or null to use `host`. */
  ssh: string | null;
  info: MachineInfo | null;
};

type Listener = (payload: unknown) => void;

const connections = new Map<string, Connection>();
const rows = new Map<string, RemoteEnv>();
const pins = new Map<string, string>();
const infos = new Map<string, MachineInfo>();
const workspaceEnv = new Map<string, string>();
const sessionEnv = new Map<string, string>();
const pathEnv = new Map<string, string>();
const routineEnv = new Map<string, string>();
const processEnv = new Map<string, string>();
/** Each remote's workspaces as last seen, so the rail keeps them while it is offline. */
const workspaceCache = new Map<string, Workspace[]>();
const listeners = new Map<string, Set<Listener>>();
/** Whether a session lives on the machine whose link just came back. */
export type Here = (sessionId: string) => boolean;

const reconnectHooks = new Set<(here: Here) => void>();
const workspaceWatchers = new Set<() => void>();
const linkWatchers = new Set<() => void>();
/** Machines that dropped after being up, so "back online" is said only after a drop. */
const dropped = new Set<string>();

let localProtocol: number | null = null;
let focused = LOCAL;
let booted: Promise<void> | null = null;
let snapshot: EnvLink[] = [];

const local = new Connection(LOCAL, () => daemonInfo());
connections.set(LOCAL, local);
wire(local);
publish();

function cacheKey(envId: string): string {
  return `env:workspaces:${envId}`;
}

export function setFocusEnv(envId: string) {
  focused = envId;
}

export function focusEnv(): string {
  return focused;
}

export function envOf(workspaceId: string): string {
  return workspaceEnv.get(workspaceId) ?? LOCAL;
}

/** A session's machine, by its id or by the id of the pane its terminal runs in. */
export function envOfSession(sessionId: string): string {
  return envForPane(sessionId, { session: sessionEnv, workspace: workspaceEnv, process: processEnv }) ?? LOCAL;
}

export function isLocalPath(path: string): boolean {
  return (envForPath(path, pathEnv) ?? LOCAL) === LOCAL;
}

/** The remote daemon's home when `path` lives on one, for `~` in its terminal. */
export function homeFor(path: string): string | null {
  const env = envForPath(path, pathEnv);
  if (env && env !== LOCAL) return infos.get(env)?.home ?? null;
  return null;
}

/** A terminal opened on a machine starts in that home, not the workspace folder. */
export function pinSessionCwd(sessionId: string, cwd: string) {
  pins.set(sessionId, cwd);
}

export function sessionCwd(sessionId: string): string | null {
  return pins.get(sessionId) ?? null;
}

export function subscribeLinks(listener: () => void): () => void {
  linkWatchers.add(listener);
  return () => linkWatchers.delete(listener);
}

export function getLinks(): EnvLink[] {
  return snapshot;
}

export function linkOf(envId: string): EnvLink | null {
  return snapshot.find((link) => link.id === envId) ?? null;
}

/** Fires when a remote's workspaces change under the rail: it came online, or it left. */
export function onWorkspacesChanged(listener: () => void): () => void {
  workspaceWatchers.add(listener);
  return () => workspaceWatchers.delete(listener);
}

/** After the Mac sleeps a socket can look open and be dead: every remote reconnects now. */
export function wakeAll() {
  for (const [env, conn] of connections) if (env !== LOCAL) conn.wake();
}

export function reconnect(envId: string) {
  connections.get(envId)?.wake();
}

/** Opens a link to each machine in the address book, and drops the ones no longer in it. */
export function refreshRemotes(): Promise<void> {
  booted = null;
  return bootRemotes();
}

export async function request<T>(method: string, params: object = {}, envId?: string): Promise<T> {
  if (envId === undefined && method === "workspace_list") return listAllWorkspaces() as Promise<T>;
  if (envId === undefined && method === "routine_list") return listAllRoutines() as Promise<T>;
  if (envId === undefined && method === "sessions_stale") return fanNumbers(method, params) as Promise<T>;
  if (envId === undefined && method === "sessions_expire") return fanStrings(method, params) as Promise<T>;

  const env = routeEnv(method, params as Record<string, unknown>, maps(), envId, focused);
  const conn = connections.get(env);
  if (!conn) throw new EnvDown(env);
  const result = await conn.request<T>(method, params);
  remember(env, method, params as Record<string, unknown>, result);
  if (method === "state_set" && isRetention(params)) mirrorRetention(params);
  return result;
}

export function on(event: string, listener: Listener): () => void {
  const set = listeners.get(event) ?? new Set();
  set.add(listener);
  listeners.set(event, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
  };
}

/** `hook` gets which sessions live on the machine that came back, so a caller resyncs only those. */
export function onReconnect(hook: (here: Here) => void): () => void {
  reconnectHooks.add(hook);
  return () => reconnectHooks.delete(hook);
}

export function openStream(
  id: number,
  onBytes: (bytes: Uint8Array) => void,
  sessionId?: string,
  replay = true,
): () => void {
  return owner(sessionId).openStream(id, onBytes, replay);
}

export function writeStream(id: number, bytes: Uint8Array, sessionId?: string): Promise<void> {
  return owner(sessionId).writeStream(id, bytes);
}

function owner(sessionId?: string): Connection {
  const env = sessionId ? envOfSession(sessionId) : LOCAL;
  return connections.get(env) ?? local;
}

function maps(): RouteMaps {
  return { workspace: workspaceEnv, session: sessionEnv, path: pathEnv, routine: routineEnv, process: processEnv };
}

function bootRemotes(): Promise<void> {
  if (!booted) {
    booted = loadRemotes().catch((error: unknown) => {
      booted = null;
      throw error;
    });
  }
  return booted;
}

async function loadRemotes() {
  const host = remotesHost();
  if (!host) return;
  let list: RemoteEnv[];
  try {
    list = await local.request<RemoteEnv[]>("remote_list", {});
  } catch {
    booted = null;
    return;
  }
  const ids = new Set(list.map((row) => row.id));
  let removed = false;
  for (const [id, conn] of connections) {
    if (id === LOCAL || ids.has(id)) continue;
    conn.stop();
    connections.delete(id);
    rows.delete(id);
    infos.delete(id);
    for (const row of workspaceCache.get(id) ?? []) workspaceEnv.delete(row.id);
    workspaceCache.delete(id);
    void local.request("state_delete", { key: cacheKey(id) }).catch(() => {});
    removed = true;
  }
  await Promise.all(list.map((row) => adoptRemote(row, host)));
  publish();
  if (removed) changed();
}

async function adoptRemote(row: RemoteEnv, host: NonNullable<ReturnType<typeof remotesHost>>) {
  const before = rows.get(row.id);
  rows.set(row.id, row);
  if (!workspaceCache.has(row.id)) await loadCache(row.id);
  const current = connections.get(row.id);
  const moved = before && (before.host !== row.host || before.port !== row.port);
  if (current && !moved) return;
  current?.stop();
  const conn = new Connection(
    row.id,
    async () => {
      const token = await host.token(row.id).catch(() => null);
      if (!token) throw new Error("No token for this machine. Remove it and add it again.");
      const now = rows.get(row.id) ?? row;
      return { url: wsUrl(now), token };
    },
    true,
  );
  connections.set(row.id, conn);
  wire(conn);
  void conn.connect().catch(() => {});
}

async function loadCache(envId: string) {
  try {
    const raw = await local.request<string | null>("state_get", { key: cacheKey(envId) });
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    const list = Array.isArray(parsed) ? parsed.filter(isWorkspace) : [];
    workspaceCache.set(envId, list);
    for (const workspace of list) registerWorkspace(envId, workspace);
  } catch {
    workspaceCache.set(envId, []);
  }
}

function storeCache(envId: string, list: Workspace[]) {
  const before = JSON.stringify(workspaceCache.get(envId) ?? []);
  const after = JSON.stringify(list);
  workspaceCache.set(envId, list);
  for (const workspace of list) registerWorkspace(envId, workspace);
  if (before === after) return false;
  void local.request("state_set", { key: cacheKey(envId), value: after }).catch(() => {});
  return true;
}

function wsUrl(row: RemoteEnv): string {
  const host = row.host.includes(":") && !row.host.startsWith("[") ? `[${row.host}]` : row.host;
  return `ws://${host}:${row.port}`;
}

function wire(conn: Connection) {
  let before = conn.status;
  conn.onEvent = (event, payload) => {
    noteEvent(conn.envId, event, payload);
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  conn.onReconnect = () => {
    const here: Here = (sessionId) => envOfSession(sessionId) === conn.envId;
    for (const hook of reconnectHooks) hook(here);
  };
  conn.onHello = (hello) => {
    if (conn.envId === LOCAL) {
      localProtocol = hello.protocol;
      for (const other of connections.values()) checkProtocol(other);
    } else {
      checkProtocol(conn);
    }
    void pullInfo(conn);
    if (conn.envId !== LOCAL) void pullWorkspaces(conn);
  };
  conn.onChange = () => {
    const now = conn.status;
    if (conn.envId !== LOCAL && now !== before) {
      const name = rows.get(conn.envId)?.name ?? "A machine";
      if (now === "offline" && conn.ever && !dropped.has(conn.envId)) {
        dropped.add(conn.envId);
        void dispatchNotification({
          source: "connection",
          title: name,
          body: "Lost the connection. Crew keeps trying.",
          key: `${conn.envId}:offline`,
        });
      }
      if (now === "online" && dropped.delete(conn.envId)) {
        void dispatchNotification({ source: "connection", title: name, body: "Back online", key: `${conn.envId}:online` });
      }
    }
    before = now;
    publish();
  };
}

function checkProtocol(conn: Connection) {
  if (conn.envId === LOCAL || localProtocol === null || conn.protocol === null) return;
  const mismatch = conn.protocol !== localProtocol;
  if (mismatch === conn.mismatch) return;
  conn.mismatch = mismatch;
  publish();
}

async function pullInfo(conn: Connection) {
  if (conn.mismatch) return;
  try {
    const next = await conn.request<MachineInfo>("daemon_info", {});
    infos.set(conn.envId, next);
    publish();
  } catch {
    // The next hello asks again.
  }
}

async function pullWorkspaces(conn: Connection) {
  if (conn.mismatch) return;
  try {
    const list = await conn.request<Workspace[]>("workspace_list", {});
    if (storeCache(conn.envId, list)) changed();
  } catch {
    // Offline again already; the cache stands.
  }
}

function changed() {
  for (const watcher of workspaceWatchers) watcher();
}

function publish() {
  snapshot = [...connections.values()].map((conn) => {
    const machine = infos.get(conn.envId) ?? null;
    const row = rows.get(conn.envId);
    return {
      id: conn.envId,
      name: conn.envId === LOCAL ? "This Mac" : (row?.name ?? conn.envId),
      status: conn.status,
      error: conn.error,
      latency: conn.latency,
      mismatch: conn.mismatch,
      version: machine?.version ?? conn.version,
      home: machine?.home ?? null,
      socksPort: machine?.socksPort ?? null,
      host: row?.host ?? null,
      user: row?.user ?? null,
      port: row?.port ?? null,
      ssh: row?.ssh || null,
      info: machine,
    };
  });
  for (const watcher of linkWatchers) watcher();
}

/**
 * This Mac's workspaces and every remote's, in the rail's saved order. A remote
 * that is not online answers from its cache, so a machine that is off or slow
 * never holds up the window; `onWorkspacesChanged` fires once it answers.
 */
async function listAllWorkspaces(): Promise<Workspace[]> {
  await bootRemotes().catch(() => {});
  const [order, localRows] = await Promise.all([readOrder(), local.request<Workspace[]>("workspace_list", {})]);
  for (const row of localRows) registerWorkspace(LOCAL, row);
  let fresh = true;
  const groups: Workspace[][] = [localRows];
  for (const [env, conn] of connections) {
    if (env === LOCAL) continue;
    if (!conn.ready) fresh = false;
    // Home is this Mac's; another machine's is not a second one.
    groups.push((workspaceCache.get(env) ?? []).filter((row) => !row.home));
  }
  const byId = new Map(groups.flat().map((row) => [row.id, row]));
  const sorted: Workspace[] = [];
  for (const id of order) {
    const row = byId.get(id);
    if (!row) continue;
    sorted.push(row);
    byId.delete(id);
  }
  for (const row of byId.values()) sorted.push(row);
  // Only a full answer rewrites the order: a machine still connecting keeps its places.
  const next = sorted.map((row) => row.id);
  if (fresh && next.join("\n") !== order.join("\n")) {
    void local.request("state_set", { key: RAIL_ORDER, value: JSON.stringify(next) }).catch(() => {});
  }
  return sorted;
}

async function readOrder(): Promise<string[]> {
  try {
    const raw = await local.request<string | null>("state_get", { key: RAIL_ORDER });
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Every connection that can answer now. A remote that is down adds nothing and fails nothing. */
async function fan<T>(method: string, params: object, empty: T): Promise<[string, T][]> {
  await bootRemotes().catch(() => {});
  return Promise.all(
    [...connections.entries()].map(async ([env, conn]): Promise<[string, T]> => {
      if (env !== LOCAL && (!conn.ready || conn.mismatch)) return [env, empty];
      try {
        return [env, await withTimeout(conn.request<T>(method, params), env === LOCAL ? 30_000 : 6_000)];
      } catch (error) {
        if (env === LOCAL) throw error;
        return [env, empty];
      }
    }),
  );
}

async function listAllRoutines(): Promise<unknown[]> {
  const lists = await fan<unknown[]>("routine_list", {}, []);
  for (const [env, list] of lists) for (const row of list) rememberRoutine(env, row);
  return lists.flatMap(([, list]) => list);
}

async function fanNumbers(method: string, params: object): Promise<number> {
  const values = await fan<number>(method, params, 0);
  return values.reduce((sum, [, value]) => sum + value, 0);
}

async function fanStrings(method: string, params: object): Promise<string[]> {
  return (await fan<string[]>(method, params, [])).flatMap(([, list]) => list);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error("The machine took too long to answer")), ms);
    work.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function remember(env: string, method: string, params: Record<string, unknown>, result: unknown) {
  if (method === "workspace_create" && isWorkspace(result)) {
    registerWorkspace(env, result);
    if (env !== LOCAL) {
      const list = workspaceCache.get(env) ?? [];
      if (!list.some((row) => row.id === result.id)) storeCache(env, [...list, result]);
    }
  }
  if (env !== LOCAL && (method === "workspace_delete" || method === "workspace_rename")) {
    const id = typeof params.id === "string" ? params.id : null;
    const list = workspaceCache.get(env) ?? [];
    if (id && method === "workspace_delete") storeCache(env, list.filter((row) => row.id !== id));
    if (id && method === "workspace_rename" && typeof params.name === "string") {
      const name = params.name;
      storeCache(env, list.map((row) => (row.id === id ? { ...row, name } : row)));
    }
  }
  if (method === "session_create" || method === "session_get" || method === "session_update") {
    if (isSession(result)) registerSession(env, result);
  }
  if (method === "session_list" && Array.isArray(result)) {
    for (const row of result) if (isSession(row)) registerSession(env, row);
  }
  if (method === "worktree_list" && Array.isArray(result)) {
    for (const row of result) {
      if (isRecord(row) && typeof row.path === "string") pathEnv.set(row.path, env);
    }
  }
  if (method === "worktree_add" && isRecord(result) && typeof result.path === "string") pathEnv.set(result.path, env);
  if (method === "routine_upsert") rememberRoutine(env, result);
  if (method.startsWith("process_")) {
    for (const row of Array.isArray(result) ? result : [result]) if (isProcess(row)) processEnv.set(row.id, env);
  }
}

function registerWorkspace(env: string, row: { id: string; path: string }) {
  workspaceEnv.set(row.id, env);
  pathEnv.set(row.path, env);
}

function registerSession(env: string, row: { id: string; workspaceId: string }) {
  sessionEnv.set(row.id, env);
  if (row.workspaceId) workspaceEnv.set(row.workspaceId, env);
}

function rememberRoutine(env: string, row: unknown) {
  if (!isRecord(row)) return;
  const routine = isRecord(row.routine) ? row.routine : row;
  if (typeof routine.id === "string") routineEnv.set(routine.id, env);
  if (isSession(row.session)) registerSession(env, row.session);
}

function noteEvent(env: string, event: string, payload: unknown) {
  if (event === "process-changed" && isProcess(payload)) processEnv.set(payload.id, env);
  if (event !== "session-created" && event !== "session-updated") return;
  if (!isRecord(payload) || !isSession(payload.session)) return;
  registerSession(env, payload.session);
}

function isRetention(params: object): boolean {
  return isRecord(params) && params.key === RETENTION_KEY;
}

function mirrorRetention(params: object) {
  for (const [env, conn] of connections) {
    if (env === LOCAL || !conn.ready || conn.mismatch) continue;
    void conn.request("state_set", params).catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isWorkspace(value: unknown): value is Workspace {
  return isRecord(value) && typeof value.id === "string" && typeof value.path === "string" && typeof value.name === "string";
}

function isSession(value: unknown): value is { id: string; workspaceId: string } {
  return isRecord(value) && typeof value.id === "string" && typeof value.workspaceId === "string";
}

function isProcess(value: unknown): value is { id: string; runs: unknown[] } {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.runs);
}
