import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoopback, Tunnels, tunnelArgs } from "./ssh-tunnel";

import { lines, named } from "./trace-recorder";

vi.mock("./trace", async () => (await import("./trace-recorder")).mockedTrace());

describe("ssh tunnels", () => {
  it("takes a crewd on the machine's loopback as one reached over ssh", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("100.102.48.125")).toBe(false);
  });

  // crewd and its SOCKS5 proxy on the next port, both only on the machine's loopback.
  it("forwards crewd and its proxy from this Mac's loopback", () => {
    const args = tunnelArgs({ destination: "atlas", user: "root", port: 2222 }, { port: 50001, socksPort: 50002 }, 17877);
    expect(args).toContain("127.0.0.1:50001:127.0.0.1:17877");
    expect(args).toContain("127.0.0.1:50002:127.0.0.1:17878");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ControlMaster=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args.slice(-6)).toEqual(["-l", "root", "-p", "2222", "--", "atlas"]);
  });
});

/** An ssh that either dies at once with `said`, or listens on its local port until killed. */
function fakeSsh(mode: "dies" | "listens", said = "ssh: connect to host atlas port 22: Connection refused\n") {
  const servers: Server[] = [];
  const run = ((_: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter & { setEncoding(): void }; kill(): void; pid: number };
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.pid = 4242;
    const exit = (code: number | null) => {
      Object.assign(child, { exitCode: code ?? 0, signalCode: null });
      child.emit("exit", code, null);
    };
    child.kill = () => exit(null);
    if (mode === "dies") {
      setImmediate(() => {
        child.stderr.emit("data", said);
        exit(255);
      });
    } else {
      const port = Number(args.find((a) => /^127\.0\.0\.1:\d+:/.test(a))?.split(":")[1]);
      const server = createServer().listen(port, "127.0.0.1");
      servers.push(server);
      child.kill = () => {
        server.close();
        exit(null);
      };
    }
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { run, close: () => servers.forEach((server) => server.close()) };
}

const target = { destination: "atlas", user: "root", port: 22 };

describe("tunnel trace", () => {
  beforeEach(() => {
    lines.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it("traces the first tries of an offline machine and then one in thirty, not every redial", async () => {
    const tunnels = new Tunnels(fakeSsh("dies").run);
    for (let i = 0; i < 61; i += 1) await tunnels.ensure("atlas", target, 17877).catch(() => {});
    // Attempts 1-5, 30 and 60.
    for (const message of ["tunnel.open", "tunnel.down", "tunnel.failed"]) {
      expect(named(message).map((line) => line.fields.attempt ?? "-")).toEqual(message === "tunnel.down" ? ["-", "-", "-", "-", "-", "-", "-"] : [1, 2, 3, 4, 5, 30, 60]);
    }
    expect(named("tunnel.failed")[0]?.fields.error).toBe("ssh: connect to host <host> port 22: Connection refused");
  });

  it("starts being loud again once the machine has been up", async () => {
    const dead = fakeSsh("dies");
    const tunnels = new Tunnels(dead.run);
    for (let i = 0; i < 8; i += 1) await tunnels.ensure("atlas", target, 17877).catch(() => {});
    expect(named("tunnel.open")).toHaveLength(5);
    const live = fakeSsh("listens");
    const back = new Tunnels(live.run);
    // The same Tunnels is what counts: carry the attempts over by using one instance.
    (tunnels as unknown as { spawnSsh: unknown }).spawnSsh = live.run;
    await tunnels.ensure("atlas", target, 17877);
    expect(named("tunnel.up")[0]?.fields.after_attempts).toBe(9);
    tunnels.close("atlas");
    (tunnels as unknown as { spawnSsh: unknown }).spawnSsh = dead.run;
    lines.length = 0;
    await tunnels.ensure("atlas", target, 17877).catch(() => {});
    expect(named("tunnel.open")[0]?.fields.attempt).toBe(1);
    back.closeAll();
    live.close();
  });

  it("says that a tunnel was closed on purpose, before its exit says it did not drop", async () => {
    const live = fakeSsh("listens");
    const tunnels = new Tunnels(live.run);
    // Nothing open for the machine: nothing to close, nothing said.
    tunnels.close("atlas");
    expect(named("tunnel.close")).toEqual([]);
    await tunnels.ensure("atlas", target, 17877);
    tunnels.close("atlas");
    expect(named("tunnel.close")).toEqual([{ level: "INFO", message: "tunnel.close", fields: { machine: "atlas" } }]);
    const order = lines.map((line) => line.message);
    expect(order.indexOf("tunnel.close")).toBeLessThan(order.indexOf("tunnel.down"));
    expect(named("tunnel.down")[0]?.fields.dropped).toBe(false);
    live.close();
  });

  it("always says when a tunnel that was up drops, and keeps ssh's last words to one line", async () => {
    const live = fakeSsh("listens");
    const tunnels = new Tunnels(live.run);
    await tunnels.ensure("atlas", target, 17877);
    tunnels.close("atlas");
    const [down] = named("tunnel.down");
    expect(down?.fields).toMatchObject({ machine: "atlas", dropped: false });
    live.close();
    lines.length = 0;
    const noisy = new Tunnels(fakeSsh("dies", "one\nsecret=\"hunter2\" invalid type: string \"hunter2\", expected u32\n").run);
    await noisy.ensure("m", target, 17877).catch(() => {});
    const said = String(named("tunnel.down")[0]?.fields.said);
    expect(said).toBe('secret="…" invalid type: string "…", expected u32');
    expect(said).not.toContain("hunter2");
  });
});
