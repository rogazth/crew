// A machine without Tailscale is reached over ssh: its crewd listens on its
// own loopback, and main forwards a port on this Mac's loopback to it (and to
// the SOCKS5 proxy on the next port) with `ssh -N -L`. The window, the
// browser host and the updater dial that local port as they would a tailnet
// address. A tunnel that drops is opened again by the next dial.

import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { isLoopback } from "../src/lib/remotes";
import { BASE_OPTIONS, controlOption, controlPath, options, who, type SshTarget } from "./ssh-options";

export { isLoopback };

/** The local ports one machine's tunnel listens on. */
export type Forward = { port: number; socksPort: number };

const READY_MS = 15_000;

export function tunnelArgs(target: SshTarget, forward: Forward, remotePort: number): string[] {
  return [
    "-N",
    ...options(BASE_OPTIONS),
    // The machine's master while it is up, so commands to it ride this connection. One a
    // command left open already is left alone, and this runs as a connection of its own.
    ...options(["ControlMaster=yes", controlOption(controlPath(target)), "ControlPersist=no"]),
    // A forward that cannot bind ends ssh, rather than leaving a tunnel that goes nowhere;
    // and the forwards listen on this Mac's loopback alone, whatever ~/.ssh/config says.
    ...options(["ExitOnForwardFailure=yes", "GatewayPorts=no"]),
    "-L",
    `127.0.0.1:${forward.port}:127.0.0.1:${remotePort}`,
    "-L",
    `127.0.0.1:${forward.socksPort}:127.0.0.1:${remotePort + 1}`,
    ...who(target),
    "--",
    target.destination,
  ];
}

/** A tunnel opening (no child yet) or open. */
type Entry = { child: ChildProcess | null; ready: Promise<Forward> };

export class Tunnels {
  private readonly open = new Map<string, Entry>();
  /** Each machine keeps its local ports while the app runs, so its address stays the same. */
  private readonly ports = new Map<string, Forward>();

  /** The machine's tunnel, opened if it is not up. Rejects with what ssh said when it cannot be. */
  ensure(key: string, target: SshTarget, remotePort: number): Promise<Forward> {
    const entry = this.open.get(key);
    // Callers that arrive while it opens share the wait.
    if (entry && (entry.child === null || (entry.child.exitCode === null && entry.child.signalCode === null))) return entry.ready;
    return this.start(key, target, remotePort);
  }

  close(key: string): void {
    this.open.get(key)?.child?.kill();
    this.open.delete(key);
  }

  closeAll(): void {
    for (const key of [...this.open.keys()]) this.close(key);
  }

  private start(key: string, target: SshTarget, remotePort: number): Promise<Forward> {
    const entry: Entry = { child: null, ready: Promise.resolve({ port: 0, socksPort: 0 }) };
    entry.ready = (async () => {
      const forward = this.ports.get(key) ?? { port: await freePort(), socksPort: await freePort() };
      this.ports.set(key, forward);
      const child = spawn("ssh", tunnelArgs(target, forward, remotePort), { stdio: ["ignore", "ignore", "pipe"] });
      entry.child = child;
      let said = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        said = (said + chunk).slice(-2_000);
      });
      child.on("exit", () => {
        if (this.open.get(key) === entry) this.open.delete(key);
        // Ports another program took are not asked for again.
        if (/Address already in use|cannot listen to port/i.test(said)) this.ports.delete(key);
      });
      await listening(forward.port, child, () => said);
      return forward;
    })();
    this.open.set(key, entry);
    entry.ready.catch(() => {
      if (this.open.get(key) === entry) this.close(key);
    });
    return entry.ready;
  }
}

/** Resolves once the local end accepts, rejects with ssh's words if it exits first. */
function listening(port: number, child: ChildProcess, said: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + READY_MS;
    let done = false;
    const fail = (why: string) => {
      if (done) return;
      done = true;
      reject(new Error(why));
    };
    child.once("exit", (code) => fail(said().trim().split("\n").at(-1) || `ssh exited ${code ?? ""}`.trim()));
    const attempt = () => {
      if (done) return;
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        if (done) return;
        done = true;
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) fail("The ssh tunnel did not open");
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
