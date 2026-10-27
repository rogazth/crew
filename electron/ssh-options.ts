// The ssh options every connection Crew opens to a machine shares, and where
// those connections meet. One connection per machine carries the rest: the
// tunnel to a machine without Tailscale is its master while it is up, and an
// install, update, restart, revive or log read rides on it instead of signing
// in again (on a public server, about half a second against two and a half).
// Without a tunnel, the first command opens a master that lingers a few
// minutes for the next one. The sockets live in the build's own data dir.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SshTarget = { destination: string; user?: string; port?: number };

/** How long a master a command opened waits for the next one. */
export const PERSIST_S = 300;

/**
 * Hardened for connections nobody watches: no prompt that would hang
 * (BatchMode), a host key taken on first use and refused if it ever changes,
 * and nothing of this Mac's handed to the machine (agent, X11, local
 * commands from ~/.ssh/config). Dead links are noticed in under a minute.
 */
export const BASE_OPTIONS = [
  "BatchMode=yes",
  "ConnectTimeout=8",
  "StrictHostKeyChecking=accept-new",
  "ForwardAgent=no",
  "ForwardX11=no",
  "PermitLocalCommand=no",
  "ServerAliveInterval=15",
  "ServerAliveCountMax=3",
];

export function options(list: readonly string[]): string[] {
  return list.flatMap((option) => ["-o", option]);
}

/** `-l` and `-p` when the target names them. */
export function who(target: SshTarget): string[] {
  return [...(target.user ? ["-l", target.user] : []), ...(target.port ? ["-p", String(target.port)] : [])];
}

/**
 * The `ControlPath` option, quoted: the data dir sits under "Application
 * Support", and ssh splits an unquoted option value at the space.
 */
export function controlOption(control: string): string {
  return `ControlPath="${control}"`;
}

/** macOS refuses a socket path past 104 bytes. */
const SOCKET_PATH_MAX = 103;

let controlDir: string | null = null;

/** Main names it at startup: `<data>/tmp/ssh`, inside the build's own environment. */
export function setControlDir(dir: string): void {
  controlDir = dir;
}

/**
 * The control socket for a machine, in a folder only this user can enter,
 * under a hash short enough for a socket path. `none` (a connection of its
 * own each time) before main named the folder, or when its path is too long.
 */
export function controlPath(target: SshTarget): string {
  if (!controlDir) return "none";
  const key = `${target.user ?? ""}@${target.destination}:${target.port ?? ""}`;
  const socket = path.join(controlDir, createHash("sha256").update(key).digest("hex").slice(0, 16));
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) return "none";
  try {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  } catch {
    return "none";
  }
  return socket;
}
