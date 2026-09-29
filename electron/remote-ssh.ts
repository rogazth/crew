// Installing crewd on a Linux machine over the system ssh. No Electron here, so
// a script can run the same steps the window does.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { resolveSsh } from "./ssh-config.ts";

export type StepId = "reach" | "ssh" | "upload" | "service" | "pair" | "clis";

export type StepUpdate = {
  id: StepId;
  state: "running" | "done" | "error";
  detail?: string;
};

/**
 * What `ssh` is given: a Host from ~/.ssh/config or an address, and a user
 * only when the one the config (or the Mac's login) would pick is not it.
 */
export type SshTarget = { destination: string; user?: string };

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
      return { unit: "crewd-local", home: ".crew-local", port: DEFAULT_PORT + 1 };
    case "dev":
      return { unit: "crewd-dev", home: ".crew-dev", port: DEFAULT_PORT + 2 };
  }
}

const RELEASE = remoteLayout("release");

export function linuxArch(uname: string): "x64" | "arm64" | null {
  if (uname.trim() === "x86_64") return "x64";
  if (uname.trim() === "aarch64" || uname.trim() === "arm64") return "arm64";
  return null;
}

/** The user unit. `%h` is the remote home, so the same text works for any user. */
export function serviceUnit(ip: string, port: number, layout: RemoteLayout = RELEASE): string {
  return `[Unit]
Description=Crew daemon${layout.unit === RELEASE.unit ? "" : ` (${layout.unit})`}
After=tailscaled.service

[Service]
ExecStart=%h/${layout.home}/bin/crewd serve --listen ${ip}:${port} --data-dir %h/${layout.home}/data
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
`;
}

export async function installDaemon(opts: {
  target: SshTarget;
  port?: number;
  binaryFor: (arch: "x64" | "arm64") => string | null;
  onStep?: (step: StepUpdate) => void;
  /** Before anything is written: may refuse the machine by its tailnet address, as one already added. */
  check?: (ip: string) => Promise<void>;
  layout?: RemoteLayout;
}): Promise<Paired> {
  const layout = opts.layout ?? RELEASE;
  const port = opts.port ?? layout.port;
  const { unit, home } = layout;
  const control = controlPath(opts.target.destination);
  const report = opts.onStep ?? (() => {});
  try {
    let route: Route = { hostname: opts.target.destination, port: 22, proxied: false };
    await step(report, "reach", async () => {
      route = await reach(opts.target);
      return `${route.hostname}:${route.port}${route.proxied ? " through a proxy" : ""}`;
    });
    await step(report, "ssh", async () => {
      const who = (await ssh(opts.target, "id -un", control)).trim();
      return `${who}@${route.hostname}`;
    });
    const ip = await tailnetIp(opts.target, control, route.hostname);
    await opts.check?.(ip);
    const uname = (await ssh(opts.target, "uname -m", control)).trim();
    const arch = linuxArch(uname);
    if (!arch) throw new Error(`${uname || "unknown"} is not a Linux architecture Crew ships`);
    const binary = opts.binaryFor(arch);
    if (!binary) throw new Error(`Crew has no Linux build for ${arch}`);
    await step(report, "upload", async () => {
      await ssh(opts.target, `mkdir -p "$HOME/${home}/bin" "$HOME/${home}/data" "$HOME/.config/systemd/user"`, control);
      await sshStream(
        opts.target,
        `cat > "$HOME/${home}/bin/crewd.new" && chmod 755 "$HOME/${home}/bin/crewd.new"`,
        control,
        binary,
      );
    });
    await step(report, "service", async () => {
      await ssh(opts.target, 'loginctl enable-linger "$(id -un)"', control);
      await ssh(
        opts.target,
        userctl(`systemctl --user stop ${unit} 2>/dev/null || true; mv "$HOME/${home}/bin/crewd.new" "$HOME/${home}/bin/crewd"`),
        control,
      );
      await sshStdin(opts.target, `cat > "$HOME/.config/systemd/user/${unit}.service"`, control, serviceUnit(ip, port, layout));
      await ssh(opts.target, userctl(`systemctl --user daemon-reload && systemctl --user enable --now ${unit}`), control);
    });
    const token = await readToken(opts.target, control, layout);
    const paired = await step(report, "pair", async () => {
      try {
        return await pair(ip, port, token);
      } catch (error) {
        const logs = await ssh(opts.target, userctl(`journalctl --user -u ${unit} -n 40 --no-pager`), control).catch(() => "");
        await ssh(opts.target, userctl(`systemctl --user stop ${unit} 2>/dev/null || true`), control).catch(() => {});
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
    });
    await step(report, "clis", async () => (paired.installed.length > 0 ? paired.installed.join(", ") : "none found"));
    return { ...paired, ip };
  } finally {
    await closeControl(opts.target, control);
  }
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

/** A user systemd command over ssh, where the session bus is not in the environment. */
function userctl(command: string): string {
  return `export XDG_RUNTIME_DIR="/run/user/$(id -u)"; export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; ${command}`;
}

async function step<T>(report: (step: StepUpdate) => void, id: StepId, run: () => Promise<T>): Promise<T> {
  report({ id, state: "running" });
  try {
    const result = await run();
    const detail = typeof result === "string" ? result : undefined;
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
async function reach(target: SshTarget): Promise<Route> {
  const resolved = await resolveSsh(target.destination, target.user).catch(() => null);
  const route = { hostname: resolved?.hostname || target.destination, port: resolved?.port ?? 22, proxied: resolved?.proxied ?? false };
  if (route.proxied) return route;
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: route.hostname, port: route.port, timeout: 6_000 });
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
async function tailnetIp(target: SshTarget, control: string, hostname: string): Promise<string> {
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

async function readToken(target: SshTarget, control: string, layout: RemoteLayout): Promise<string> {
  let last = "The daemon did not write its token";
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const token = (await ssh(target, `cat "$HOME/${layout.home}/data/token"`, control)).trim();
      if (token) return token;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(last);
}

export function pair(ip: string, port: number, token: string): Promise<Paired> {
  return rpc<DaemonPayload>(ip, port, token, "daemon_info", {}, 20_000).then((result) => ({
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

function sshArgs(target: SshTarget, control: string): string[] {
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
    "--",
    target.destination,
  ];
}

function ssh(target: SshTarget, remote: string, control: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(target, control), remote], { stdio: ["ignore", "pipe", "pipe"] });
    collect(child, resolve, reject);
  });
}

function sshStdin(target: SshTarget, remote: string, control: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(target, control), remote], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(body);
    collect(child, () => resolve(), reject);
  });
}

function sshStream(target: SshTarget, remote: string, control: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(target, control), remote], { stdio: ["pipe", "pipe", "pipe"] });
    const input = createReadStream(file);
    input.on("error", reject);
    input.pipe(child.stdin);
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
    const child = spawn("ssh", ["-o", `ControlPath=${control}`, "-O", "exit", ...(target.user ? ["-l", target.user] : []), "--", target.destination], {
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
