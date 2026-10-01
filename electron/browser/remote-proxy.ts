import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { aliasOfHost, isPlainLoopback, MACHINE_HEADER } from "../../src/lib/browser/machines";

/**
 * A proxy on this Mac's loopback that every page's loopback goes through once
 * a workspace lives on another machine. `<machine>.localhost` is that
 * machine's `localhost`: the relay dials the SOCKS proxy beside its
 * `crewd serve`, with the daemon token as the password. So is a plain
 * `localhost` request that names a machine in MACHINE_HEADER, which only a
 * plain-HTTP request can show. Everything else it dials from here, so
 * browsing does not egress from a machine.
 *
 * Chromium can do neither half itself: its SOCKS5 client sends no password,
 * and it never hands loopback to a PAC script, so a session can only send its
 * `localhost` somewhere through fixed proxy rules, and those take every host.
 * Pages talk HTTP proxy to the relay; a 407 asks them for the relay's own
 * token, which the app's `login` handler answers, so nothing else on this Mac
 * can use it.
 */
export type RemoteRelay = {
  /** The port on 127.0.0.1 pages are pointed at. */
  port: number;
  /** What a page presents as its proxy credentials. */
  token: string;
  /**
   * Every machine, by alias; null for one it can't reach now, whose name then
   * fails rather than reach this Mac. A re-paired machine hands out a new
   * token; the relay follows.
   */
  setMachines(machines: ReadonlyMap<string, Upstream | null>): void;
  close(): Promise<void>;
};

/**
 * Chromium's bypass list for a relayed session: every host that cannot be
 * loopback, so only `localhost`, `*.localhost`, `127.x`, `::1` and the odd
 * single-label or IPv6 name reach the relay. The list has no negation, so the
 * names are spelled out: dotted names ending in a letter (every public TLD),
 * except those ending in `.localhost`; and IPv4 outside 127/8.
 */
export function relayBypassRules(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-";
  const letters = chars.slice(0, 26);
  const suffix = "localhost";
  const rules = ["<-loopback>"];
  // Ending in a letter other than localhost's last.
  for (const c of letters) if (c !== suffix.at(-1)) rules.push(`*.*${c}`);
  // Ending in the last k letters of `localhost`, the one before them differing from localhost's.
  for (let k = 1; k < suffix.length; k++) {
    const tail = suffix.slice(-k);
    const before = suffix.at(-k - 1);
    for (const c of chars) if (c !== before) rules.push(`*.*${c}${tail}`);
    rules.push(`*.${tail}`);
  }
  // `…xlocalhost`: a name that only ends like it, not a subdomain of it.
  for (const c of chars) rules.push(`*.*${c}${suffix}`);
  rules.push("0.0.0.0/2", "64.0.0.0/3", "96.0.0.0/4", "112.0.0.0/5", "120.0.0.0/6", "124.0.0.0/7", "126.0.0.0/8", "128.0.0.0/1");
  return rules.join(",");
}

export type Upstream = { host: string; port: number; token: string };

export type Destination = { host: string; port: number; loopback: boolean };
type Dial = (dest: Destination) => Promise<Socket>;
/** `machine` is what the request's MACHINE_HEADER named, if anything. */
type Route = (dest: Destination, machine: string | null) => Promise<Socket>;

/** `direct` is how this Mac's hosts are reached; tests stand in for the network. */
export async function startRelay(opts: { token?: string; direct?: Dial } = {}): Promise<RemoteRelay> {
  const token = opts.token ?? randomBytes(24).toString("hex");
  const direct = opts.direct ?? directConnect;
  let machines: ReadonlyMap<string, Upstream | null> = new Map();
  const reach = (alias: string, dest: { host: string; port: number }) => {
    const upstream = machines.get(alias);
    return upstream ? socksConnect(upstream, dest) : Promise.reject(new Error(`${alias} is not connected`));
  };
  const route: Route = (dest, machine) => {
    const named = aliasOfHost(dest.host);
    if (named && machines.has(named)) return reach(named, { host: "localhost", port: dest.port });
    if (machine && machines.has(machine) && isPlainLoopback(dest.host)) return reach(machine, { host: dest.host, port: dest.port });
    // A `*.localhost` no machine answers to is this Mac's, as Chromium would have it.
    return direct(dest.host.endsWith(".localhost") ? { ...dest, host: "localhost" } : dest);
  };
  const server: Server = createServer((req, res) => forward(req, res, token, route));
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => tunnel(req, client, head, token, route));
  // Proxied pages reuse their connections; a dev server's HMR socket stays open for hours.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    token,
    setMachines: (next) => {
      machines = new Map(next);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Whether the Basic credentials carry the token, as the user or the password. */
export function authorized(header: string | undefined, token: string): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return decoded.slice(0, colon) === token || decoded.slice(colon + 1) === token;
}

/** Where a URL or CONNECT line points, and whether that is loopback: `localhost`, `*.localhost`, `127.x` or `::1`. */
export function destination(host: string, port: number): Destination | null {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!bare || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const loopback =
    bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  return { host: bare, port, loopback };
}

function directConnect(dest: Destination): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: dest.host, port: dest.port, noDelay: true });
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

const PROXY_AUTH = `Proxy-Authenticate: Basic realm="crew"`;

function forward(req: IncomingMessage, res: ServerResponse, token: string, route: Route): void {
  if (!authorized(req.headers["proxy-authorization"], token)) {
    res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="crew"', "Content-Length": "0" }).end();
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "");
  } catch {
    res.writeHead(400, { "Content-Length": "0" }).end();
    return;
  }
  const dest = url.protocol === "http:" ? destination(url.hostname, Number(url.port || 80)) : null;
  if (!dest) {
    res.writeHead(400, { "Content-Length": "0" }).end();
    return;
  }
  const headers = { ...req.headers };
  const named = headers[MACHINE_HEADER];
  const machine = typeof named === "string" ? named : null;
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  delete headers[MACHINE_HEADER];
  const options: RequestOptions = {
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers,
    createConnection: (_opts, done) => {
      route(dest, machine).then(
        (socket) => {
          done(null, socket);
          // The request attaches its reader first; both run on the next tick, in this order.
          socket.resume();
        },
        (error: Error) => done(error, undefined as never),
      );
      return undefined;
    },
  };
  const out = httpRequest(options);
  out.on("response", (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
    answer.pipe(res);
  });
  out.on("error", () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(502, { "Content-Length": "0" }).end();
  });
  res.on("close", () => out.destroy());
  req.pipe(out);
}

function tunnel(req: IncomingMessage, client: Duplex, head: Buffer, token: string, route: Route): void {
  client.on("error", () => client.destroy());
  if (!authorized(req.headers["proxy-authorization"], token)) {
    client.end(`HTTP/1.1 407 Proxy Authentication Required\r\n${PROXY_AUTH}\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  const at = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
  const dest = at ? destination(at[1]!, Number(at[2])) : null;
  if (!dest) {
    client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  // A CONNECT carries none of the page's headers: only the name says which machine.
  route(dest, null).then(
    (socket) => {
      if (client.destroyed) {
        socket.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
      socket.on("error", () => client.destroy());
      socket.on("close", () => client.destroy());
      client.on("close", () => socket.destroy());
    },
    () => client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"),
  );
}

const SOCKS_TIMEOUT_MS = 10_000;

/** A socket to `dest` on the machine, through crewd's SOCKS5 with the token as the password. */
export function socksConnect(upstream: Upstream, dest: { host: string; port: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: upstream.host, port: upstream.port, noDelay: true });
    const reader = bytes(socket);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(SOCKS_TIMEOUT_MS, () => fail(new Error("socks: timed out")));
    socket.once("error", fail);
    socket.once("connect", async () => {
      try {
        socket.write(Buffer.from([5, 1, 0x02]));
        const chosen = await reader(2);
        if (chosen[0] !== 5 || chosen[1] !== 0x02) throw new Error("socks: password auth refused");
        const secret = Buffer.from(upstream.token, "utf8");
        socket.write(Buffer.concat([Buffer.from([1, secret.length]), secret, Buffer.from([secret.length]), secret]));
        const status = await reader(2);
        if (status[1] !== 0) throw new Error("socks: wrong token");
        socket.write(connectRequest(dest));
        const answer = await reader(4);
        if (answer[1] !== 0) throw new Error(`socks: connect refused (${answer[1]})`);
        const rest = answer[3] === 0x01 ? 4 : answer[3] === 0x04 ? 16 : (await reader(1))[0]!;
        await reader(rest + 2);
        socket.setTimeout(0);
        socket.off("error", fail);
        const leftover = reader.release();
        if (leftover.length) socket.unshift(leftover);
        resolve(socket);
      } catch (error) {
        fail(error as Error);
      }
    });
  });
}

function connectRequest(dest: { host: string; port: number }): Buffer {
  const port = Buffer.from([dest.port >> 8, dest.port & 0xff]);
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(dest.host)) {
    return Buffer.concat([Buffer.from([5, 1, 0, 0x01, ...dest.host.split(".").map(Number)]), port]);
  }
  if (dest.host === "::1") {
    return Buffer.concat([Buffer.from([5, 1, 0, 0x04, ...new Array(15).fill(0), 1]), port]);
  }
  const name = Buffer.from(dest.host, "utf8");
  return Buffer.concat([Buffer.from([5, 1, 0, 0x03, name.length]), name, port]);
}

/** Reads exact byte counts off a socket during the handshake, then hands back what came after. */
function bytes(socket: Socket): ((count: number) => Promise<Buffer>) & { release(): Buffer } {
  let buffered = Buffer.alloc(0);
  let wanted: { count: number; resolve: (chunk: Buffer) => void; reject: (error: Error) => void } | null = null;
  const drain = () => {
    if (!wanted || buffered.length < wanted.count) return;
    const { count, resolve } = wanted;
    wanted = null;
    const chunk = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    resolve(chunk);
  };
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    drain();
  };
  const onEnd = () => wanted?.reject(new Error("socks: closed during the handshake"));
  socket.on("data", onData);
  socket.on("end", onEnd);
  const read = (count: number) =>
    new Promise<Buffer>((resolve, reject) => {
      wanted = { count, resolve, reject };
      drain();
    });
  return Object.assign(read, {
    release: () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.pause();
      return buffered;
    },
  });
}
