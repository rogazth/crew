import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import { CHANNELS } from "../src/lib/browser/bridge";
import { LOCAL } from "../src/lib/client/route";
import { isMachineAlias } from "../src/lib/browser/machines";
import type { RemoteEnv } from "../src/lib/protocol";
import { AUTO_UPDATE, DEFAULT_PORT, INSTALL_JOB, type InstallInput, type ManualRemote, type RemoteUpdateResult, type RemoteUpdateState } from "../src/lib/remotes";
import { setRemoteResolver } from "./browser/files";
import { setMachines } from "./browser/guests";
import type { Upstream } from "./browser/remote-proxy";
import type { Machine } from "./browser/remote-hosts";
import { release } from "./build-info";
import { channelOf } from "./channel";
import { daemonLogs, installDaemon, InstallCancelled, remoteLayout, peek, removeDaemon, restartDaemon, reviveDaemon, rpc, sshDestination, type SshTarget } from "./remote-ssh";
import { dropToken, getToken, putToken } from "./remote-tokens";
import { remoteUpdater } from "./remote-updates";
import { sshHosts } from "./ssh-config";
import { setControlDir } from "./ssh-options";
import { isLoopback, Tunnels } from "./ssh-tunnel";
import { tailnetFrom } from "./tailscale";
import type { Tailnet } from "../src/lib/remotes";

const exec = promisify(execFile);

const TAILSCALE = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

type Daemon = { url: string; token: string };

/** How often a machine that stays offline is checked over ssh for a stopped crewd. */
const REVIVE_EVERY_MS = 60_000;

let machinesChanged: () => void = () => {};

/** The ssh tunnels to machines whose crewd listens on their own loopback. */
const tunnels = new Tunnels();

/**
 * Where this Mac dials a machine's crewd, and its SOCKS5 proxy: its tailnet
 * address as kept, or this Mac's end of its ssh tunnel, opened if it is not up.
 */
export async function endpointOf(row: RemoteEnv): Promise<{ host: string; port: number; socksPort: number }> {
  if (!isLoopback(row.host)) return { host: row.host, port: row.port, socksPort: row.port + 1 };
  const forward = await tunnels.ensure(row.id, targetOf(row), row.port);
  return { host: "127.0.0.1", port: forward.port, socksPort: forward.socksPort };
}

function originAt(at: { host: string; port: number }): string {
  const host = at.host.includes(":") && !at.host.startsWith("[") ? `[${at.host}]` : at.host;
  return `http://${host}:${at.port}`;
}

/** Told when a machine is added, paired again or removed, so the browser host dials it. */
export function onMachinesChanged(listener: () => void): void {
  machinesChanged = listener;
}

/** Every machine in the address book with a token, at the address a browser host dials. */
export async function remoteMachines(getDaemon: () => Daemon | null): Promise<Machine[]> {
  const rows = await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {});
  const machines: Machine[] = [];
  for (const row of rows) {
    const token = await getToken(row.id);
    if (!token) continue;
    // A machine whose tunnel cannot open now is left for the next look, as one offline is.
    const at = await endpointOf(row).catch(() => null);
    if (at) machines.push({ id: row.id, name: row.name, url: originAt(at).replace(/^http:/, "ws:"), token });
  }
  return machines;
}

export function linuxBinary(arch: "x64" | "arm64"): string | null {
  const name = `crewd-linux-${arch}`;
  const candidates = [path.join(process.resourcesPath, name), path.join(app.getAppPath(), "target", "linux", name)];
  return candidates.find((file) => existsSync(file)) ?? null;
}

/** This app's crewd on a machine: the release's, or a dev or local build's own beside it. */
function layout() {
  return remoteLayout(channelOf(app.isPackaged, release));
}

/** What "this Mac" does for `restart` and `logs`, in place of ssh. */
export type LocalDaemon = { restart(): Promise<void>; logs(): Promise<string> };

export function registerRemoteIpc(getDaemon: () => Daemon | null, thisMac: LocalDaemon): void {
  // Where every ssh to a machine meets the one already open to it.
  setControlDir(path.join(app.getPath("userData"), "tmp", "ssh"));
  powerMonitor.on("resume", () => {
    // Tunnels that slept are dead whatever ssh thinks: the next dial opens fresh ones.
    tunnels.closeAll();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("remotes:wake");
    }
  });

  ipcMain.handle("remotes:tailnet", async (): Promise<Tailnet> => {
    const bin = TAILSCALE.find((file) => existsSync(file));
    if (!bin) return { state: "missing", account: null, message: "Tailscale is not installed on this Mac", devices: [] };
    const rows = await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {}).catch(() => []);
    const added = new Set(
      rows.flatMap((row) => [row.host, row.name, row.ssh, row.ssh?.replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/:\d+$/, "")].filter(Boolean)),
    );
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

  /** The install running now, if any: cancelling aborts it. */
  let installing: AbortController | null = null;
  /** Settles once the install running now has let go of the machine, so a new one can start. */
  let settled: Promise<unknown> = Promise.resolve();

  ipcMain.handle("remotes:cancel-install", async () => {
    installing?.abort();
    await settled;
  });

  ipcMain.handle("remotes:install", async (event, input: InstallInput) => {
    const target = sshOf(input);
    if (installing) throw new Error("Another machine is being set up");
    const controller = new AbortController();
    installing = controller;
    const work = (async () => {
      // The form offers the release's port; a dev or local build keeps off it, so it never meets the release's crewd.
      const port = input.port === undefined || input.port === DEFAULT_PORT ? layout().port : input.port;
      // A crewd already running there at this app's protocol is paired with as it is.
      const local = await localRpc<{ protocol?: number }>(getDaemon, "daemon_info", {}).catch(() => null);
      const paired = await installDaemon({
        target,
        port,
        layout: layout(),
        signal: controller.signal,
        ...(typeof local?.protocol === "number" ? { reuseProtocol: local.protocol } : {}),
        binaryFor: linuxBinary,
        // The same machine under another name (a public alias, its tailnet IP) is refused before anything changes there.
        check: async (ip) => {
          const rows = await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {});
          // On its loopback every machine looks alike, so those are told apart by their ssh destination.
          const same = rows.find((row) =>
            isLoopback(ip) ? isLoopback(row.host) && row.ssh === sshDestination(target) && row.port === port : row.host === ip && row.port === port,
          );
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
      if (controller.signal.aborted) throw new InstallCancelled();
      const row = await localRpc<RemoteEnv>(getDaemon, "remote_upsert", {
        id: "",
        name: input.name.trim() || target.destination,
        host: paired.ip,
        port,
        user: target.user ?? "",
        ssh: sshDestination(target),
      });
      await putToken(row.id, paired.token);
      machinesChanged();
      return row;
    })();
    settled = work.catch(() => {});
    try {
      return await work;
    } finally {
      installing = null;
    }
  });

  /**
   * Machines an update, restart or removal is working on over ssh. A revive
   * then would start the old binary mid-update, start one being removed, or
   * close the ssh connection the other run shares with it.
   */
  const busy = new Set<string>();
  /** When each machine was last revived, so an unreachable one is not dialled over and over. */
  const revived = new Map<string, number>();

  /** Every window hears an update's steps, whoever started it: the card says which one it is on. */
  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  async function updateMachine(row: RemoteEnv): Promise<{ warning: string | null }> {
    if (busy.has(row.id)) throw new Error(`${row.name} is busy with another job`);
    busy.add(row.id);
    try {
      const paired = await installDaemon({
        target: targetOf(row),
        port: row.port,
        layout: layout(),
        keepOnFailure: true,
        binaryFor: linuxBinary,
        onStep: (step) => broadcast("remotes:progress", { ...step, job: row.id }),
      });
      await putToken(row.id, paired.token);
      machinesChanged();
      return { warning: paired.warning ?? null };
    } finally {
      busy.delete(row.id);
    }
  }

  const updater = remoteUpdater({
    machines: () => localRpc<RemoteEnv[]>(getDaemon, "remote_list", {}),
    peek: async (row) => {
      const token = await getToken(row.id);
      if (!token) throw new Error("No token");
      const at = await endpointOf(row);
      return peek(at.host, at.port, token);
    },
    target: async () => {
      const info = getDaemon();
      if (!info) return null;
      const url = new URL(info.url);
      return (await peek(url.hostname, Number(url.port), info.token).catch(() => null))?.version || null;
    },
    auto: async () => (await localRpc<string | null>(getDaemon, "state_get", { key: AUTO_UPDATE }).catch(() => null)) !== "off",
    busy: (id) => busy.has(id) || installing !== null,
    update: updateMachine,
    publish: (states: Record<string, RemoteUpdateState>) => broadcast("remotes:update-states", states),
    finished: (result: RemoteUpdateResult) => broadcast("remotes:auto-updated", result),
  });
  updater.start();
  app.on("before-quit", () => {
    updater.stop();
    tunnels.closeAll();
  });

  ipcMain.handle("remotes:update", async (_event, id: unknown) => {
    const row = await requireRow(getDaemon, id);
    if (updater.states()[row.id]?.state === "updating") throw new Error(`${row.name} is already being updated`);
    updater.cancel(row.id);
    return updateMachine(row);
  });

  /** Its sessions mid-turn or waiting on an answer, which an update now would cut off. */
  ipcMain.handle("remotes:busy-sessions", async (_event, id: unknown): Promise<number> => {
    const row = await requireRow(getDaemon, id);
    const token = await getToken(row.id);
    if (!token) return 0;
    const at = await endpointOf(row);
    return (await peek(at.host, at.port, token)).agentsRunning;
  });

  ipcMain.handle("remotes:queue-update", async (_event, id: unknown) => {
    const row = await requireRow(getDaemon, id);
    // Not awaited: an idle machine updates at once, and the window follows it through the states.
    void updater.queue(row.id);
  });

  ipcMain.handle("remotes:cancel-update", (_event, id: unknown) => {
    if (typeof id === "string") updater.cancel(id);
  });

  ipcMain.handle("remotes:update-states", () => updater.states());

  ipcMain.handle("remotes:revive", async (_event, id: unknown): Promise<boolean> => {
    const row = await requireRow(getDaemon, id);
    if (busy.has(row.id) || installing) return false;
    const last = revived.get(row.id) ?? 0;
    if (Date.now() - last < REVIVE_EVERY_MS) return false;
    revived.set(row.id, Date.now());
    const said = await reviveDaemon(targetOf(row), layout()).catch(() => "unreachable");
    if (said === "started") console.warn(`crewd on ${row.name} was stopped; started it again`);
    return said === "started";
  });

  ipcMain.handle("remotes:restart", async (_event, id: unknown) => {
    if (id === LOCAL) return thisMac.restart();
    const row = await requireRow(getDaemon, id);
    busy.add(row.id);
    try {
      await restartDaemon(targetOf(row), layout());
    } finally {
      busy.delete(row.id);
    }
  });

  ipcMain.handle("remotes:remove", async (_event, id: unknown, wipe: unknown) => {
    const row = await requireRow(getDaemon, id);
    let warning: string | null = null;
    busy.add(row.id);
    try {
      await removeDaemon(targetOf(row), wipe === true, layout());
      tunnels.close(row.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warning = `Removed from Crew, but crewd may still run on ${row.name}: ${reason}`;
    } finally {
      busy.delete(row.id);
    }
    await dropToken(row.id);
    await localRpc(getDaemon, "remote_delete", { id: row.id });
    machinesChanged();
    return { warning };
  });

  ipcMain.handle("remotes:logs", async (_event, id: unknown) => {
    if (id === LOCAL) return thisMac.logs();
    const row = await requireRow(getDaemon, id);
    return daemonLogs(targetOf(row), layout());
  });

  /** Where the window dials a machine: its tailnet address, or this Mac's end of its ssh tunnel. */
  ipcMain.handle("remotes:endpoint", async (_event, id: unknown): Promise<string> => {
    const row = await requireRow(getDaemon, id);
    return originAt(await endpointOf(row)).replace(/^http:/, "ws:");
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
    machinesChanged();
    return row;
  });

  setRemoteResolver(async (envId) => {
    const token = await getToken(envId);
    const row = (await localRpc<RemoteEnv[]>(getDaemon, "remote_list", {}).catch(() => [])).find((item) => item.id === envId);
    return token && row ? { origin: originAt(await endpointOf(row)), token } : null;
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
      if (!row || !token || typeof port !== "number") {
        machines.set(item.alias, null);
        continue;
      }
      // Over ssh, the proxy is reached at this Mac's end of the tunnel, not at the port crewd reports.
      const at = await endpointOf(row).catch(() => null);
      machines.set(item.alias, at ? { host: at.host, port: isLoopback(row.host) ? at.socksPort : port, token } : null);
    }
    await setMachines(machines);
  });
}

function sshOf(input: InstallInput): SshTarget {
  const destination = input.ssh.trim();
  const user = input.user.trim();
  if (!destination) throw new Error("Which machine? Pick one or type its address");
  if (destination.startsWith("-") || /\s/.test(destination)) throw new Error(`"${destination}" is not a host ssh can use`);
  const sshPort = input.sshPort;
  if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
    throw new Error(`${String(sshPort)} is not an SSH port`);
  }
  return { destination, ...(user ? { user } : {}), ...(sshPort ? { port: sshPort } : {}) };
}

/** A machine added before `ssh` was kept is reached at its tailnet address, as it was installed. */
function targetOf(row: RemoteEnv): SshTarget {
  const destination = row.ssh || row.host;
  return row.user ? { destination, user: row.user } : { destination };
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
