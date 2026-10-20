// Installing crewd on a Linux machine over the system ssh. No Electron here, so
// a script can run the same steps the window does.
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import type { InstallFailure } from "../src/lib/remotes.ts";
import { classifyInstallFailure } from "./install-errors.ts";
import { resolveSsh } from "./ssh-config.ts";

export type StepId = "reach" | "ssh" | "existing" | "upload" | "service" | "pair" | "clis";

export type StepUpdate = {
  id: StepId;
  state: "running" | "done" | "error" | "skipped";
  detail?: string;
  /** Bytes sent and in all, while the upload runs. */
  received?: number;
  total?: number;
  /** On an error, what it means and what to do. */
  failure?: InstallFailure;
};

/**
 * What `ssh` is given: a Host from ~/.ssh/config or an address, a user only
 * when the one the config (or the Mac's login) would pick is not it, and a
 * port only when ssh should not use the one the config (or 22) gives.
 */
export type SshTarget = { destination: string; user?: string; port?: number };

/** A target an install can abort: ending it kills the ssh runs under it. */
type Link = SshTarget & { signal?: AbortSignal };

/** The install was cancelled by the person; nothing is wrong. */
export class InstallCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "InstallCancelled";
  }
}

export type Paired = {
  token: string;
  version: string;
  protocol: number;
  os: string;
  home: string;
  installed: string[];
  socksPort: number | null;
  /** The tailnet address the daemon is listening on. */
  ip: string;
  /** Installed and running, but something the user should know: lingering could not be turned on. */
  warning?: string | null;
};

/** Same number as `DEFAULT_PORT` in src/lib/remotes.ts. Kept here so this file stays free of app imports. */
const DEFAULT_PORT = 17877;

/** Which app installs crewd: the published release, a package built here, or a dev build. */
export type Channel = "release" | "local" | "dev";

/**
 * Where one app's crewd lives on a machine: its user unit, the folder under
 * the home that holds its binary and data, and the port it listens on unless
 * told another. The release's is what it always was. A dev or local build
 * adding the same machine gets its own, so it never replaces the release's
 * binary, restarts its daemon or reads its data.
 */
export type RemoteLayout = { unit: string; home: string; port: number };

export function remoteLayout(channel: Channel): RemoteLayout {
  switch (channel) {
    case "release":
      return { unit: "crewd", home: ".crew", port: DEFAULT_PORT };
    case "local":
      // Two apart: a daemon's SOCKS listener takes the port after its own.
      return { unit: "crewd-local", home: ".crew-local", port: DEFAULT_PORT + 2 };
    case "dev":
      return { unit: "crewd-dev", home: ".crew-dev", port: DEFAULT_PORT + 4 };
  }
}

const RELEASE = remoteLayout("release");

export function linuxArch(uname: string): "x64" | "arm64" | null {
  if (uname.trim() === "x86_64") return "x64";
  if (uname.trim() === "aarch64" || uname.trim() === "arm64") return "arm64";
  return null;
}

/**
 * The user unit. `%h` is the remote home, so the same text works for any user.
 *
 * Every session's CLI, and every build or test it runs, lives in this unit's
 * cgroup. systemd's default `OOMPolicy=stop` takes the whole unit down when
 * the kernel kills any one of them for memory, and every session with it: the
 * OOM killer ends the one process, and crewd and the other sessions go on.
 */
export function serviceUnit(ip: string, port: number, layout: RemoteLayout = RELEASE): string {
  return `[Unit]
Description=Crew daemon${layout.unit === RELEASE.unit ? "" : ` (${layout.unit})`}
After=tailscaled.service

[Service]
ExecStart=%h/${layout.home}/bin/crewd serve --listen ${ip}:${port} --data-dir %h/${layout.home}/data
Restart=on-failure
RestartSec=1
OOMPolicy=continue

[Install]
WantedBy=default.target
`;
}

/**
 * Writes the data dir's layout.json (crew_core::paths) unless it has one: the
 * worktrees go in the build's own folder, and the release's Home is `~/Crew`,
 * as it always was. Builds of every channel then keep apart on the machine.
 */
export function writeLayoutCommand(layout: RemoteLayout = RELEASE): string {
  const file = `"$HOME/${layout.home}/data/layout.json"`;
  const json =
    layout.unit === RELEASE.unit
      ? `'{"workDir":"%s","homeFolder":"%s"}\\n' "$HOME/${layout.home}" "$HOME/Crew"`
      : `'{"workDir":"%s"}\\n' "$HOME/${layout.home}"`;
  return `[ -e ${file} ] || printf ${json} > ${file}`;
}

/**
 * Turns lingering on for the ssh user, so systemd keeps their manager, crewd
 * and the routines it fires running with nobody logged in, then says whether
 * it is on: `linger=yes`, or `linger=no` and what loginctl said. Most
 * distros' polkit lets a user turn it on for themselves; some ask for an
 * admin. Never fails, and asks for no sudo: crewd runs either way, only not
 * past a logout. Run again on every install and update, which is harmless.
 * In `sh -c`, since the login shell may not be a POSIX one.
 */
export const LINGER_COMMAND = `sh -c 'u="$(id -un)"; said="$(loginctl enable-linger "$u" 2>&1)"; if loginctl show-user "$u" -p Linger 2>/dev/null | grep -qx Linger=yes || [ -e "/var/lib/systemd/linger/$u" ]; then echo linger=yes; else printf "linger=no %s\\n" "$said"; fi'`;

/** What to tell the user when LINGER_COMMAND found lingering off; null when it is on. */
export function lingerWarning(output: string, user: string): string | null {
  if (/^linger=yes$/m.test(output)) return null;
  const said = output.replace(/^linger=no\s*/m, "").trim().split("\n")[0]?.trim() ?? "";
  return (
    `crewd runs, but systemd may stop it once you log out of the machine, and routines there stop with it: ` +
    `lingering could not be turned on${said ? ` (${said})` : ""}. ` +
    `An admin can turn it on with: sudo loginctl enable-linger ${user}`
  );
}

export async function installDaemon(opts: {
  target: SshTarget;
  port?: number;
  /** Aborting it stops the install: the ssh runs end and the half-uploaded file goes. */
  signal?: AbortSignal;
  /**
   * The protocol this app speaks. A crewd already running on the machine at
   * this protocol is paired with as it is: no upload, no service change.
   */
  reuseProtocol?: number;
  binaryFor: (arch: "x64" | "arm64") => string | null;
  onStep?: (step: StepUpdate) => void;
  /** Before anything is written: may refuse the machine by its tailnet address, as one already added. */
  check?: (ip: string) => Promise<void>;
  layout?: RemoteLayout;
}): Promise<Paired> {
  const layout = opts.layout ?? RELEASE;
  const port = opts.port ?? layout.port;
  const { unit, home } = layout;
  const signal = opts.signal;
  const target: Link = { ...opts.target, ...(signal ? { signal } : {}) };
  const control = controlPath(target.destination);
  const emit = opts.onStep ?? (() => {});
  // A step that fails says what it means; one cancelled says nothing.
  const report = (update: StepUpdate) => {
    if (signal?.aborted) return;
    const context = {
      destination: target.destination,
      port,
      ...(target.user ? { user: target.user } : {}),
      ...(target.port ? { sshPort: target.port } : {}),
    };
    emit(update.state === "error" ? { ...update, failure: classifyInstallFailure(update.detail ?? "", context) } : update);
  };
  try {
    let route: Route = { hostname: target.destination, port: target.port ?? 22, proxied: false };
    await step(report, "reach", async () => {
      route = await reach(target);
      return `${route.hostname}:${route.port}${route.proxied ? " through a proxy" : ""}`;
    });
    let who = "";
    await step(report, "ssh", async () => {
      who = (await ssh(target, "id -un", control)).trim();
      return `${who}@${route.hostname}`;
    });
    let ip = "";
    let running: Paired | null = null;
    await step(report, "existing", async () => {
      ip = await tailnetIp(target, control, route.hostname);
      await opts.check?.(ip);
      if (opts.reuseProtocol === undefined) return ip;
      // A crewd already listening here, at a protocol this app speaks, only needs pairing.
      const token = (await ssh(target, `cat "$HOME/${home}/data/token"`, control).catch(() => "")).trim();
      if (token) {
        const found = await pair(ip, port, token, 5_000).catch(() => null);
        if (found && found.protocol === opts.reuseProtocol) running = found;
      }
      return running ? `crewd ${(running as Paired).version} already runs` : "Not installed yet";
    });
    if (running) {
      report({ id: "upload", state: "skipped", detail: "Not needed" });
      report({ id: "service", state: "skipped", detail: "Already running" });
      const paired = running as Paired;
      await step(report, "pair", async () => paired, pairedDetail);
      await step(report, "clis", async () => (paired.installed.length > 0 ? paired.installed.join(", ") : "none found"));
      return { ...paired, ip, warning: null };
    }
    const uname = (await ssh(target, "uname -m", control)).trim();
    const arch = linuxArch(uname);
    if (!arch) throw new Error(`${uname || "unknown"} is not a Linux architecture Crew ships`);
    const binary = opts.binaryFor(arch);
    if (!binary) throw new Error(`Crew has no Linux build for ${arch}`);
    await step(report, "upload", async () => {
      await ssh(target, `mkdir -p "$HOME/${home}/bin" "$HOME/${home}/data" "$HOME/.config/systemd/user"`, control);
      await ssh(target, writeLayoutCommand(layout), control);
      const total = statSync(binary).size;
      let last = 0;
      report({ id: "upload", state: "running", received: 0, total });
      await sshStream(
        target,
        `cat > "$HOME/${home}/bin/crewd.new" && chmod 755 "$HOME/${home}/bin/crewd.new"`,
        control,
        binary,
        (received) => {
          // Often enough to move a bar, not so often it floods the window.
          const now = Date.now();
          if (received < total && now - last < 100) return;
          last = now;
          report({ id: "upload", state: "running", received, total });
        },
      );
    });
    // Not fatal: crewd runs either way, and the warning says what is missing.
    let warning: string | null = null;
    await step(report, "service", async () => {
      // First, as it always was: lingering also starts the user's systemd
      // manager, which `systemctl --user` below needs.
      const linger = await ssh(target, LINGER_COMMAND, control).catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      );
      warning = lingerWarning(linger, who || "<user>");
      if (warning) console.warn(`crewd on ${target.destination}: ${warning}`);
      await ssh(target, userctl(swapBinary(layout)), control);
      await sshStdin(target, `cat > "$HOME/.config/systemd/user/${unit}.service"`, control, serviceUnit(ip, port, layout));
      await ssh(target, userctl(`systemctl --user daemon-reload && systemctl --user enable --now ${unit}`), control);
      return warning ?? undefined;
    });
    const token = await readToken(target, control, layout);
    const paired = await step(
      report,
      "pair",
      async () => {
        try {
          return await pair(ip, port, token);
        } catch (error) {
          if (signal?.aborted) throw error;
          const logs = await ssh(target, userctl(`journalctl --user -u ${unit} -n 40 --no-pager`), control).catch(() => "");
          await ssh(target, userctl(`systemctl --user stop ${unit} 2>/dev/null || true`), control).catch(() => {});
          if (logs.includes("Address already in use")) {
            throw new Error(`Port ${port} is already in use on that machine`);
          }
          const reason = error instanceof Error ? error.message : String(error);
          const tail = logs
            .trim()
            .split("\n")
            .filter((line) => line.includes("[crewd]"))
            .slice(-1)[0];
          throw new Error(tail ? `${reason}. ${tail}` : reason);
        }
      },
      pairedDetail,
    );
    await step(report, "clis", async () => (paired.installed.length > 0 ? paired.installed.join(", ") : "none found"));
    return { ...paired, ip, warning };
  } catch (error) {
    if (!signal?.aborted) throw error;
    // Best effort: the half-uploaded binary goes; a service already started is left as it is.
    await ssh({ ...opts.target }, `rm -f "$HOME/${home}/bin/crewd.new"`, control).catch(() => {});
    throw new InstallCancelled();
  } finally {
    await closeControl(opts.target, control);
  }
}

function pairedDetail(paired: Paired): string {
  return `crewd ${paired.version || "?"}${paired.os ? ` · ${paired.os}` : ""}`;
}

/**
 * What a machine keeps as its ssh destination. A port other than the config's
 * rides in an ssh:// address, which ssh takes anywhere a host goes, so
 * updating, restarting and removing dial the same port the install did.
 */
export function sshDestination(target: SshTarget): string {
  return target.port && !target.destination.includes("://") ? `ssh://${target.destination}:${target.port}` : target.destination;
}

export async function restartDaemon(target: SshTarget, layout: RemoteLayout = RELEASE): Promise<void> {
  const control = controlPath(target.destination);
  try {
    await ssh(target, userctl(`systemctl --user restart ${layout.unit}`), control);
  } finally {
    await closeControl(target, control);
  }
}

export async function removeDaemon(target: SshTarget, wipe: boolean, layout: RemoteLayout = RELEASE): Promise<void> {
  const { unit, home } = layout;
  const control = controlPath(target.destination);
  try {
    await ssh(
      target,
      userctl(
        `systemctl --user disable --now ${unit} 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/${unit}.service"; systemctl --user daemon-reload 2>/dev/null || true`,
      ),
      control,
    );
    if (wipe) await ssh(target, `rm -rf "$HOME/${home}"`, control);
  } finally {
    await closeControl(target, control);
  }
}

export async function daemonLogs(target: SshTarget, layout: RemoteLayout = RELEASE): Promise<string> {
  const control = controlPath(target.destination);
  try {
    return await ssh(target, userctl(`journalctl --user -u ${layout.unit} -n 200 --no-pager`), control);
  } finally {
    await closeControl(target, control);
  }
}

/**
 * Stops the unit and puts the uploaded crewd in place, with `crew` a link to
 * it: crewd runs as the CLI under that name, and it is the `crew` a session
 * on the machine is pointed at, beside the crewd that runs it.
 */
export function swapBinary({ unit, home }: RemoteLayout): string {
  const bin = `"$HOME/${home}/bin"`;
  return `systemctl --user stop ${unit} 2>/dev/null || true; mv ${bin}/crewd.new ${bin}/crewd && ln -sfn crewd ${bin}/crew`;
}

/** A user systemd command over ssh, where the session bus is not in the environment. */
function userctl(command: string): string {
  return `export XDG_RUNTIME_DIR="/run/user/$(id -u)"; export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; ${command}`;
}

async function step<T>(
  report: (step: StepUpdate) => void,
  id: StepId,
  run: () => Promise<T>,
  describe?: (result: T) => string | undefined,
): Promise<T> {
  report({ id, state: "running" });
  try {
    const result = await run();
    const detail = describe ? describe(result) : typeof result === "string" ? result : undefined;
    report(detail ? { id, state: "done", detail } : { id, state: "done" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report({ id, state: "error", detail: message });
    throw error instanceof Error ? error : new Error(message);
  }
}

type Route = { hostname: string; port: number; proxied: boolean };

/**
 * Where ssh will go for this target, as ~/.ssh/config says, and that it
 * answers there. Through a ProxyJump or ProxyCommand only ssh itself can tell.
 */
async function reach(target: Link): Promise<Route> {
  target.signal?.throwIfAborted();
  const resolved = await resolveSsh(target.destination, target.user, target.port).catch(() => null);
  const route = { hostname: resolved?.hostname || target.destination, port: resolved?.port ?? target.port ?? 22, proxied: resolved?.proxied ?? false };
  if (route.proxied) return route;
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: route.hostname, port: route.port, timeout: 6_000 });
    target.signal?.addEventListener("abort", () => socket.destroy(new Error("Cancelled")), { once: true });
    const fail = (why: string) => {
      socket.destroy();
      reject(new Error(`Could not reach ${route.hostname} on port ${route.port}: ${why}`));
    };
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => fail("no answer"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      fail(error.code === "ENOTFOUND" ? "unknown host" : (error.code ?? error.message)),
    );
  });
  return route;
}

/** 100.64.0.0/10, where Tailscale hands out addresses. */
export function isTailnetIp(ip: string): boolean {
  const match = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
  return !!match && Number(match[1]) >= 64 && Number(match[1]) <= 127;
}

/**
 * The address crewd listens on. Never a public one: crewd speaks plain
 * WebSocket, and only the tailnet's WireGuard keeps that private.
 */
async function tailnetIp(target: Link, control: string, hostname: string): Promise<string> {
  try {
    const text = await ssh(target, "tailscale ip -4", control);
    const ip = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line));
    if (ip) return ip;
  } catch {
    // A machine without the CLI can still be reached by the address we were given.
  }
  if (isTailnetIp(hostname)) return hostname;
  throw new Error("The machine is not on your tailnet. Crew reaches crewd over Tailscale: install it there and sign in");
}

async function readToken(target: Link, control: string, layout: RemoteLayout): Promise<string> {
  let last = "The daemon did not write its token";
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const token = (await ssh(target, `cat "$HOME/${layout.home}/data/token"`, control)).trim();
      if (token) return token;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    target.signal?.throwIfAborted();
    await delay(250);
  }
  throw new Error(last);
}

export function pair(ip: string, port: number, token: string, timeout = 20_000): Promise<Paired> {
  return rpc<DaemonPayload>(ip, port, token, "daemon_info", {}, timeout).then((result) => ({
    token,
    version: result.version ?? "",
    protocol: result.protocol ?? 0,
    os: result.os ?? "",
    home: result.home ?? "",
    installed: Array.isArray(result.installed) ? result.installed : [],
    socksPort: typeof result.socksPort === "number" ? result.socksPort : null,
    ip,
  }));
}

type DaemonPayload = {
  version?: string;
  protocol?: number;
  os?: string;
  home?: string;
  installed?: string[];
  socksPort?: number;
};

export function rpc<T>(ip: string, port: number, token: string, method: string, params: object, timeout = 8_000): Promise<T> {
  const url = `ws://${ip.includes(":") ? `[${ip}]` : ip}:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`No answer from ${url}`));
    }, timeout);
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else if (value !== undefined) resolve(value);
    };
    ws.onopen = () => ws.send(JSON.stringify({ auth: token }));
    ws.onerror = () => finish(new Error(`Could not reach ${url}`));
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: { event?: string; id?: number; ok?: boolean; result?: T; error?: string };
      try {
        message = JSON.parse(event.data) as typeof message;
      } catch {
        return;
      }
      if (message.event === "hello") {
        ws.send(JSON.stringify({ id: 1, method, params }));
        return;
      }
      if (message.id !== 1) return;
      if (!message.ok || message.result === undefined) finish(new Error(message.error || `${method} failed`));
      else finish(undefined, message.result);
    };
  });
}

function controlPath(host: string): string {
  const safe = host.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "host";
  return path.join("/tmp", `crewssh-${safe}-${process.pid}`);
}

export function sshArgs(target: SshTarget, control: string): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${control}`,
    "-o",
    "ControlPersist=30",
    ...(target.user ? ["-l", target.user] : []),
    ...(target.port ? ["-p", String(target.port)] : []),
    "--",
    target.destination,
  ];
}

function spawnSsh(target: Link, remote: string, control: string, stdin: "ignore" | "pipe") {
  return spawn("ssh", [...sshArgs(target, control), remote], {
    stdio: [stdin, "pipe", "pipe"],
    ...(target.signal ? { signal: target.signal } : {}),
  });
}

function ssh(target: Link, remote: string, control: string): Promise<string> {
  return new Promise((resolve, reject) => {
    collect(spawnSsh(target, remote, control, "ignore"), resolve, reject);
  });
}

function sshStdin(target: Link, remote: string, control: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnSsh(target, remote, control, "pipe");
    child.stdin?.end(body);
    collect(child, () => resolve(), reject);
  });
}

/** Pipes a file to a remote command, saying how many bytes have gone as they do. */
function sshStream(target: Link, remote: string, control: string, file: string, onProgress?: (received: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnSsh(target, remote, control, "pipe");
    const input = createReadStream(file);
    let received = 0;
    input.on("data", (chunk) => {
      received += chunk.length;
      onProgress?.(received);
    });
    input.on("error", reject);
    if (child.stdin) input.pipe(child.stdin);
    collect(child, () => resolve(), reject);
  });
}

function collect(child: ReturnType<typeof spawn>, resolve: (stdout: string) => void, reject: (error: Error) => void) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr.trim() || stdout.trim() || `ssh exited ${code ?? ""}`.trim()));
  });
}

async function closeControl(target: SshTarget, control: string) {
  await new Promise<void>((resolve) => {
    const child = spawn("ssh", ["-o", `ControlPath=${control}`, "-O", "exit", ...(target.user ? ["-l", target.user] : []), ...(target.port ? ["-p", String(target.port)] : []), "--", target.destination], {
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
