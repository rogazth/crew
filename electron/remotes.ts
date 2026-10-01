import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import { CHANNELS } from "../src/lib/browser/bridge";
import { isMachineAlias } from "../src/lib/browser/machines";
import type { RemoteEnv } from "../src/lib/protocol";
import { DEFAULT_PORT, INSTALL_JOB, type InstallInput, type ManualRemote } from "../src/lib/remotes";
import { bindRemoteRoot, unbindRemoteRoot } from "./browser/files";
import { setMachines } from "./browser/guests";
import type { Upstream } from "./browser/remote-proxy";
import { release } from "./build-info";
import { daemonLogs, installDaemon, remoteLayout, removeDaemon, restartDaemon, rpc, type SshTarget } from "./remote-ssh";
import { dropToken, getToken, putToken } from "./remote-tokens";
import { sshHosts } from "./ssh-config";
import { tailnetFrom } from "./tailscale";
import type { Tailnet } from "../src/lib/remotes";

const exec = promisify(execFile);

const TAILSCALE = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

type Daemon = { url: string; token: string };

export function linuxBinary(arch: "x64" | "arm64"): string | null {
  const name = `crewd-linux-${arch}`;
  const candidates = [path.join(process.resourcesPath, name), path.join(app.getAppPath(), "target", "linux", name)];
  return candidates.find((file) => existsSync(file)) ?? null;
}

/** This app's crewd on a machine: the release's, or a dev or local build's own beside it. */
function layout() {
  return remoteLayout(app.isPackaged ? (release ? "release" : "local") : "dev");
}

export function registerRemoteIpc(getDaemon: () => Daemon | null): void {
  powerMonitor.on("resume", () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("remotes:wake");
    }
  });

  ipcMain.handle("remotes:tailnet", async (): Promise<Tailnet> => {
    const bin = TAILSCALE.find((file) => existsSync(file));
    if (!bin) return { state: "missing", account: null, message: "Tailscale is not installed on this Mac", devices: [] };
    const rows = await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {}).catch(() => []);
    const added = new Set(rows.flatMap((row) => [row.host, row.name, row.ssh].filter(Boolean)));
    try {
      const { stdout } = await exec(bin, ["status", "--json"], { timeout: 8_000, maxBuffer: 8_000_000 });
      return tailnetFrom(JSON.parse(stdout), added);
    } catch (error) {
      // A stopped Tailscale exits non-zero and still prints its state.
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.trim().startsWith("{")) {
        try {
          return tailnetFrom(JSON.parse(stdout), added);
        } catch {
          // Fall through to the error.
        }
      }
      return { state: "error", account: null, message: error instanceof Error ? error.message : String(error), devices: [] };
    }
  });

  ipcMain.handle("remotes:ssh-hosts", () => sshHosts().catch(() => []));

  ipcMain.handle("remotes:install", async (event, input: InstallInput) => {
    const target = sshOf(input);
    // The form offers the release's port; a dev or local build keeps off it, so it never meets the release's crewd.
    const port = input.port === undefined || input.port === DEFAULT_PORT ? layout().port : input.port;
    const paired = await installDaemon({
      target,
      port,
      layout: layout(),
      binaryFor: linuxBinary,
      // The same machine under another name (a public alias, its tailnet IP) is refused before anything changes there.
      check: async (ip) => {
        const rows = await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {});
        const same = rows.find((row) => row.host === ip && row.port === port);
        if (same) {
          throw new Error(
            `That machine is already in Crew as ${same.name} (${ip}). To reach it through ${target.destination}, use Edit… in ${same.name}'s menu.`,
          );
        }
      },
      onStep: (step) => {
        if (!event.sender.isDestroyed()) event.sender.send("remotes:progress", { ...step, job: INSTALL_JOB });
      },
    });
    const row = await localRpc<RemoteEnv>(getDaemon, "remote_upsert", {
      id: "",
      name: input.name.trim() || target.destination,
      host: paired.ip,
      port,
      user: target.user ?? "",
      ssh: target.destination,
    });
    await putToken(row.id, paired.token);
    return row;
  });

  ipcMain.handle("remotes:update", async (event, id: unknown) => {
    const row = await requireRow(getDaemon, id);
    await installDaemon({
      target: targetOf(row),
      port: row.port,
      layout: layout(),
      binaryFor: linuxBinary,
      onStep: (step) => {
        if (!event.sender.isDestroyed()) event.sender.send("remotes:progress", { ...step, job: row.id });
      },
    }).then(async (paired) => {
      await putToken(row.id, paired.token);
    });
  });

  ipcMain.handle("remotes:restart", async (_event, id: unknown) => {
    const row = await requireRow(getDaemon, id);
    await restartDaemon(targetOf(row), layout());
  });

  ipcMain.handle("remotes:remove", async (_event, id: unknown, wipe: unknown) => {
    const row = await requireRow(getDaemon, id);
    let warning: string | null = null;
    try {
      await removeDaemon(targetOf(row), wipe === true, layout());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warning = `Removed from Crew, but crewd may still run on ${row.name}: ${reason}`;
    }
    await dropToken(row.id);
    await localRpc(getDaemon, "remote_delete", { id: row.id });
    return { warning };
  });

  ipcMain.handle("remotes:logs", async (_event, id: unknown) => {
    const row = await requireRow(getDaemon, id);
    return daemonLogs(targetOf(row), layout());
  });

  ipcMain.handle("remotes:token", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id) return null;
    return getToken(id);
  });

  ipcMain.handle("remotes:add", async (_event, input: ManualRemote) => {
    const row = await localRpc<RemoteEnv>(getDaemon, "remote_upsert", {
      id: input.id,
      name: input.name,
      host: input.host,
      port: input.port,
      user: input.user,
      ssh: input.ssh ?? "",
    });
    await putToken(row.id, input.token);
    return row;
  });

  ipcMain.handle("files:bind-remote", async (_event, root: unknown, envId: unknown) => {
    if (typeof root !== "string" || typeof envId !== "string") return;
    const token = await getToken(envId);
    const row = (await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {}).catch(() => [])).find((item) => item.id === envId);
    if (!token || !row) return;
    bindRemoteRoot(root, { origin: originOf(row), token });
  });

  ipcMain.handle("files:unbind-remote", (_event, root: unknown) => {
    if (typeof root === "string") unbindRemoteRoot(root);
  });

  /** Each machine the window knows, by alias; one not connected, or with no proxy, is kept with none. */
  ipcMain.handle(CHANNELS.machines, async (_event, list: unknown) => {
    if (!Array.isArray(list)) return;
    const rows = await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {}).catch(() => []);
    const machines = new Map<string, Upstream | null>();
    for (const item of list.slice(0, 64) as Array<{ alias?: unknown; envId?: unknown; socksPort?: unknown }>) {
      if (typeof item !== "object" || item === null || !isMachineAlias(item.alias)) continue;
      const row = rows.find((candidate) => candidate.id === item.envId);
      const port = item.socksPort;
      const token = row && typeof port === "number" ? await getToken(row.id) : null;
      machines.set(item.alias, row && token && typeof port === "number" ? { host: row.host, port, token } : null);
    }
    await setMachines(machines);
  });
}

function sshOf(input: InstallInput): SshTarget {
  const destination = input.ssh.trim();
  const user = input.user.trim();
  if (!destination) throw new Error("Which machine? Pick one or type its address");
  if (destination.startsWith("-") || /\s/.test(destination)) throw new Error(`"${destination}" is not a host ssh can use`);
  return user ? { destination, user } : { destination };
}

/** A machine added before `ssh` was kept is reached at its tailnet address, as it was installed. */
function targetOf(row: RemoteEnv): SshTarget {
  const destination = row.ssh || row.host;
  return row.user ? { destination, user: row.user } : { destination };
}

function originOf(row: RemoteEnv): string {
  const host = row.host.includes(":") && !row.host.startsWith("[") ? `[${row.host}]` : row.host;
  return `http://${host}:${row.port}`;
}

async function requireRow(getDaemon: () => Daemon | null, id: unknown): Promise<RemoteEnv> {
  if (typeof id !== "string" || !id) throw new Error("Missing machine");
  const row = (await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {})).find((item) => item.id === id);
  if (!row) throw new Error("That machine is not in Crew");
  return row;
}

function localRpc<T>(getDaemon: () => Daemon | null, method: string, params: object): Promise<T> {
  const info = getDaemon();
  if (!info) return Promise.reject(new Error("Crew daemon is not running"));
  const url = new URL(info.url);
  const host = url.hostname;
  const port = Number(url.port);
  return rpc<T>(host, port, info.token, method, params);
}
