import { invoke } from "@tauri-apps/api/core";
import type { ProjectFile, Session, SessionKind, SessionStatus, Workspace } from "./types";

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

export const listSessions = (workspaceId: string): Promise<Session[]> =>
  invoke("session_list", { workspaceId });

export const createSession = (
  workspaceId: string,
  kind: SessionKind,
  input: { name: string; provider: string; model: string; description: string },
): Promise<Session> => invoke("session_create", { workspaceId, kind, ...input });

export const updateSession = (
  id: string,
  input: {
    name: string;
    provider: string;
    model: string;
    description: string;
    notifications: boolean;
  },
): Promise<void> => invoke("session_update", { id, ...input });

export const renameSession = (id: string, name: string): Promise<void> =>
  invoke("session_rename", { id, name });

export const deleteSession = (id: string): Promise<void> =>
  invoke("session_delete", { id });

export const setSessionStatus = (id: string, status: SessionStatus): Promise<void> =>
  invoke("session_set_status", { id, status });

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

export const killPty = (id: string): Promise<void> => invoke("pty_kill", { id });
