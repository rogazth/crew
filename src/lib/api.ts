import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RoutineRow, ScheduledRoutine } from "./routines";
import type { Autonomy, ProjectFile, Session, SessionKind, SessionStatus, Workspace } from "./types";

/** Native picker. No filters: any document the agent can read. */
export async function pickFiles(): Promise<string[]> {
  const picked = await open({ multiple: true, directory: false });
  if (picked == null) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export const listWorkspaces = (): Promise<Workspace[]> => invoke("workspace_list");

export const createWorkspace = (name: string, path: string): Promise<Workspace> =>
  invoke("workspace_create", { name, path });

export const renameWorkspace = (id: string, name: string): Promise<void> =>
  invoke("workspace_rename", { id, name });

export const deleteWorkspace = (id: string): Promise<void> =>
  invoke("workspace_delete", { id });

export const getActiveWorkspace = (): Promise<string | null> =>
  invoke("active_workspace_get");

export const setActiveWorkspace = (id: string | null): Promise<void> =>
  invoke("active_workspace_set", { id });

export const getSession = (id: string): Promise<Session | null> => invoke("session_get", { id });

export const listSessions = (workspaceId: string): Promise<Session[]> =>
  invoke("session_list", { workspaceId });

export const createSession = (
  workspaceId: string,
  kind: SessionKind,
  input: { name: string; provider: string; model: string; description: string; autonomy: Autonomy },
): Promise<Session> => invoke("session_create", { workspaceId, kind, ...input });

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
): Promise<void> => invoke("session_update", { id, ...input });

export const renameSession = (id: string, name: string): Promise<void> =>
  invoke("session_rename", { id, name });

export const deleteSession = (id: string): Promise<void> =>
  invoke("session_delete", { id });

export const setSessionStatus = (id: string, status: SessionStatus): Promise<void> =>
  invoke("session_set_status", { id, status });

export const getSessionBlocks = (id: string): Promise<string> =>
  invoke("session_get_blocks", { id });

export const setSessionBlocks = (id: string, blocksJson: string): Promise<void> =>
  invoke("session_set_blocks", { id, blocksJson });

export const setProviderSession = (id: string, providerSessionId: string): Promise<void> =>
  invoke("session_set_provider_session", { id, providerSessionId });

export const resolveClaude = (): Promise<{ path: string }> => invoke("agent_resolve_claude");

export const resolveBinary = (name: string): Promise<{ path: string }> =>
  invoke("agent_resolve", { name });

export const spawnAgent = (
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<number> => invoke("agent_spawn", { sessionId, command, args, cwd, env });

export const writeAgent = (sessionId: string, line: string): Promise<void> =>
  invoke("agent_write", { sessionId, line });

export const closeAgentStdin = (sessionId: string): Promise<void> =>
  invoke("agent_close_stdin", { sessionId });

export const killAgent = (sessionId: string): Promise<void> =>
  invoke("agent_kill", { sessionId });

export const killAllAgents = (): Promise<void> => invoke("agent_kill_all");

export const runningAgents = (): Promise<string[]> => invoke("agent_running");

export const listSessionRoutines = (sessionId: string): Promise<RoutineRow[]> =>
  invoke("routine_list_for_session", { sessionId });

export const listRoutines = (): Promise<ScheduledRoutine[]> => invoke("routine_list");

export const upsertRoutine = (input: {
  id?: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: string;
  nextRunAt: number | null;
  createdBy?: string;
}): Promise<RoutineRow> => invoke("routine_upsert", { id: null, ...input });

export const deleteRoutine = (id: string): Promise<void> => invoke("routine_delete", { id });

export const markRoutineRun = (
  id: string,
  lastRunAt: number,
  nextRunAt: number | null,
  runsJson: string,
): Promise<void> => invoke("routine_mark_run", { id, lastRunAt, nextRunAt, runsJson });

export type BridgeInfo = { socketPath: string; token: string; exe: string };

export const bridgeInfo = (): Promise<BridgeInfo> => invoke("bridge_info");

export const bridgeReply = (id: number, response: unknown): Promise<void> =>
  invoke("bridge_reply", { id, response });

export const stateGet = (key: string): Promise<string | null> => invoke("state_get", { key });

export const stateSet = (key: string, value: string): Promise<void> =>
  invoke("state_set", { key, value });

export const reorderSessions = (ids: string[]): Promise<void> =>
  invoke("session_reorder", { ids });

export const reorderWorkspaces = (ids: string[]): Promise<void> =>
  invoke("workspace_reorder", { ids });

export const listProjectFiles = (cwd: string): Promise<ProjectFile[]> =>
  invoke("list_project_files", { cwd });

export const readTextFile = (path: string): Promise<string> =>
  invoke("read_text_file", { path });

export const writeTextFile = (path: string, contents: string): Promise<void> =>
  invoke("write_text_file", { path, contents });

export const pathExists = (path: string): Promise<boolean> => invoke("path_exists", { path });

export const readFileBase64 = (path: string): Promise<{ mime: string; data: string }> =>
  invoke("read_file_base64", { path });

/** Clipboard files have no path; the CLIs Crew hosts only take paths. */
export async function writeTempFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // fromCharCode takes the array as arguments, so a whole screenshot blows the stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const extension = file.type.split("/")[1] ?? file.name.split(".").pop() ?? "bin";
  return invoke("write_temp_file", { extension, base64Contents: btoa(binary) });
}

export const spawnPty = (
  id: string,
  cwd: string,
  command: string[],
  cols: number,
  rows: number,
): Promise<void> => invoke("pty_spawn", { id, cwd, command, cols, rows });

export const writePty = (id: string, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

export const resizePty = (id: string, cols: number, rows: number): Promise<void> =>
  invoke("pty_resize", { id, cols, rows });

/** Cumulative bytes xterm has parsed; the host stops reading the PTY when the renderer falls behind. */
export const ackPty = (id: string, processed: number): Promise<void> =>
  invoke("pty_ack", { id, processed });

export const killPty = (id: string): Promise<void> => invoke("pty_kill", { id });
