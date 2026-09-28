import { createServer as createHttpServer, request, type Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { authorized, destination, relayBypassRules, startRelay, type Destination, type RemoteRelay } from "./remote-proxy";

const TOKEN = "secret-token";
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("authorized", () => {
  it.each([
    [basic(TOKEN, TOKEN), true],
    [basic("x", TOKEN), true],
    [basic(TOKEN, "x"), true],
    [basic("x", "y"), false],
    ["Bearer abc", false],
    [undefined, false],
  ])("%s → %s", (header, expected) => {
    expect(authorized(header, TOKEN)).toBe(expected);
  });
});

describe("destination", () => {
  it.each([
    ["localhost", 3000, { host: "localhost", port: 3000, loopback: true }],
    ["app.localhost", 3000, { host: "app.localhost", port: 3000, loopback: true }],
    ["127.0.0.1", 80, { host: "127.0.0.1", port: 80, loopback: true }],
    ["[::1]", 5173, { host: "::1", port: 5173, loopback: true }],
    ["Example.com", 443, { host: "example.com", port: 443, loopback: false }],
    ["10.0.0.1", 80, { host: "10.0.0.1", port: 80, loopback: false }],
    ["localhost", 0, null],
    ["", 80, null],
  ])("%s:%s", (host, port, expected) => {
    expect(destination(host, port)).toEqual(expected);
  });
});

describe("relayBypassRules", () => {
  const rules = relayBypassRules().split(",");
  /** Chromium's hostname rules: `*` and `?` wildcards over the whole host. */
  const bypassed = (host: string) =>
    rules
      .filter((rule) => !rule.startsWith("<") && !rule.includes("/"))
      .some((rule) => new RegExp(`^${rule.replace(/[.+^${}()|[\]\\-]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(host));

  it("keeps Chromium's implicit loopback bypass off", () => {
    expect(rules[0]).toBe("<-loopback>");
  });

  it.each(["example.com", "github.io", "x.net", "docs.rs", "example.st", "foo.host", "a.b.c.dev", "mylocalhost.com", "x.notlocalhost"])(
    "%s skips the relay",
    (host) => {
      expect(bypassed(host)).toBe(true);
    },
  );

  it.each(["localhost", "app.localhost", "a.b.localhost", "127.0.0.1", "devbox", "10.0.0.1"])("%s goes to the relay by name", (host) => {
    expect(bypassed(host)).toBe(false);
  });

  it("sends IPv4 off 127/8 around the relay by range", () => {
    const ranges = rules.filter((rule) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(rule));
    const inRange = (ip: string) =>
      ranges.some((range) => {
        const [base, bits] = range.split("/");
        const n = (a: string) => a.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
        const mask = 2 ** 32 - 2 ** (32 - Number(bits));
        return (n(ip) & mask) >>> 0 === (n(base!) & mask) >>> 0;
      });
    expect(["10.0.0.1", "1.1.1.1", "126.255.255.255", "128.0.0.1", "192.168.1.1", "255.255.255.255", "0.0.0.0"].every(inRange)).toBe(true);
    expect(["127.0.0.1", "127.255.0.1"].some(inRange)).toBe(false);
  });
});

/** crewd's SOCKS5, as the machine runs it: password auth with the token, loopback only. */
async function fakeSocks(token: string): Promise<{ port: number; server: Server; dials: string[] }> {
  const dials: string[] = [];
  const server = createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;
    client.on("error", () => {});
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2 && buffer.length >= 2 + buffer[1]!) {
        const methods = buffer.subarray(2, 2 + buffer[1]!);
        buffer = buffer.subarray(2 + buffer[1]!);
        if (!methods.includes(2)) return client.end(Buffer.from([5, 0xff]));
        client.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1 && buffer.length >= 2) {
        const ulen = buffer[1]!;
        if (buffer.length < 3 + ulen) return;
        const plen = buffer[2 + ulen]!;
        if (buffer.length < 3 + ulen + plen) return;
        const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
        buffer = buffer.subarray(3 + ulen + plen);
        if (pass !== token) return client.end(Buffer.from([1, 1]));
        client.write(Buffer.from([1, 0]));
        stage = 2;
      }
      if (stage === 2 && buffer.length >= 5) {
        const atyp = buffer[3]!;
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffer[4]!;
        if (buffer.length < 4 + len + 2) return;
        const host = atyp === 3 ? buffer.subarray(5, 5 + buffer[4]!).toString() : atyp === 1 ? [...buffer.subarray(4, 8)].join(".") : "::1";
        const port = buffer.readUInt16BE(4 + len);
        const rest = buffer.subarray(4 + len + 2);
        stage = 3;
        client.off("data", onData);
        dials.push(`${host}:${port}`);
        const upstream = connect({ host: host === "localhost" ? "127.0.0.1" : host, port });
        upstream.on("error", () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        upstream.on("connect", () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          upstream.pipe(client);
          client.pipe(upstream);
        });
      }
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server, dials };
}

async function pageServer(): Promise<{ port: number; server: HttpServer }> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.method} ${req.url} ${req.headers["proxy-authorization"] ? "leaked" : "clean"} ${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

function viaProxy(
  relay: number,
  url: string,
  opts: { auth?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: relay,
      method: opts.method ?? "GET",
      path: url,
      headers: opts.auth ? { "proxy-authorization": opts.auth } : {},
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** A CONNECT through the relay, then a raw HTTP/1.0 GET inside the tunnel. */
function tunnelGet(relay: number, target: string, auth?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: "127.0.0.1", port: relay });
    let data = "";
    socket.on("connect", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
    });
    let sent = false;
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!sent && data.startsWith("HTTP/1.1 200")) {
        sent = true;
        socket.write(`GET /tunnel HTTP/1.0\r\nHost: ${target}\r\n\r\n`);
      }
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

describe("startRelay", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  /** Hosts off loopback, dialed from this Mac: here they all land on the page server. */
  const directs: string[] = [];
  async function setup(token = TOKEN) {
    const socks = await fakeSocks(TOKEN);
    const page = await pageServer();
    directs.length = 0;
    const direct = (dest: Destination) =>
      new Promise<Socket>((resolve, reject) => {
        directs.push(`${dest.host}:${dest.port}`);
        const socket = connect({ host: "127.0.0.1", port: page.port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    const relay: RemoteRelay = await startRelay({ host: "127.0.0.1", port: socks.port, token }, { direct });
    cleanup.push(
      () => relay.close(),
      () => {
        socks.server.close();
        page.server.closeAllConnections();
        page.server.close();
      },
    );
    return { socks, page, relay };
  }

  it("asks for the token before anything goes out", async () => {
    const { page, relay, socks } = await setup();
    const answer = await viaProxy(relay.port, `http://localhost:${page.port}/`);
    expect(answer.status).toBe(407);
    expect(socks.dials).toEqual([]);
    expect(await tunnelGet(relay.port, `localhost:${page.port}`)).toMatch(/^HTTP\/1\.1 407/);
  });

  it("forwards a plain request through the machine's SOCKS, without the proxy credentials", async () => {
    const { page, relay, socks } = await setup();
    const answer = await viaProxy(relay.port, `http://localhost:${page.port}/a?b=1`, { auth: basic(TOKEN, TOKEN), method: "POST", body: "hi" });
    expect(answer).toEqual({ status: 200, body: "POST /a?b=1 clean hi" });
    expect(socks.dials).toEqual([`localhost:${page.port}`]);
    const ip = await viaProxy(relay.port, `http://127.0.0.1:${page.port}/ip`, { auth: basic(TOKEN, TOKEN) });
    expect(ip.body).toBe("GET /ip clean ");
    expect(socks.dials).toEqual([`localhost:${page.port}`, `127.0.0.1:${page.port}`]);
  });

  it("tunnels a CONNECT, as a websocket or https page opens one", async () => {
    const { page, relay, socks } = await setup();
    const reply = await tunnelGet(relay.port, `localhost:${page.port}`, basic(TOKEN, TOKEN));
    expect(reply).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK/);
    expect(reply).toContain("GET /tunnel clean");
    expect(socks.dials).toEqual([`localhost:${page.port}`]);
  });

  it("sends *.localhost to the machine's localhost", async () => {
    const { page, relay, socks } = await setup();
    const answer = await viaProxy(relay.port, `http://app.localhost:${page.port}/sub`, { auth: basic(TOKEN, TOKEN) });
    expect(answer.body).toBe("GET /sub clean ");
    expect(socks.dials).toEqual([`localhost:${page.port}`]);
  });

  it("dials hosts off loopback from this Mac, not through the machine", async () => {
    const { relay, socks } = await setup();
    const plain = await viaProxy(relay.port, "http://example.com/x", { auth: basic(TOKEN, TOKEN) });
    expect(plain.body).toBe("GET /x clean ");
    expect(await tunnelGet(relay.port, "example.com:443", basic(TOKEN, TOKEN))).toContain("GET /tunnel clean");
    expect(directs).toEqual(["example.com:80", "example.com:443"]);
    expect(socks.dials).toEqual([]);
    expect((await viaProxy(relay.port, "http://example.com/", {})).status).toBe(407);
  });

  it("answers 502 when the machine refuses the token, and follows a new one", async () => {
    const { page, relay } = await setup("stale");
    const url = `http://localhost:${page.port}/`;
    expect((await viaProxy(relay.port, url, { auth: basic("stale", "stale") })).status).toBe(502);
    relay.setToken(TOKEN);
    expect((await viaProxy(relay.port, url, { auth: basic("stale", "stale") })).status).toBe(407);
    expect((await viaProxy(relay.port, url, { auth: basic(TOKEN, TOKEN) })).status).toBe(200);
  });

  it("answers 502 when the machine is gone", async () => {
    const { page, relay, socks } = await setup();
    await new Promise<void>((resolve) => socks.server.close(() => resolve()));
    expect((await viaProxy(relay.port, `http://localhost:${page.port}/`, { auth: basic(TOKEN, TOKEN) })).status).toBe(502);
  });
});
