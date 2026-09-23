// Pages the e2e specs point the browser at. Every route is deterministic, and
// the slow one waits for the spec instead of a timer, so loading states can be
// asserted without racing a clock.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Fixtures = {
  origin: string;
  url(path: string): string;
  /** Finishes every held `/slow/:name` request; later ones for that name answer at once. */
  release(name: string): void;
  close(): Promise<void>;
};

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const html = (title: string, body = "") =>
  `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>${body}`;

// Keys land in `window.__keys` as "meta+l" or "x". Bare modifier presses are
// left out: a test cares about the chord, and sendInputEvent never sends them.
const TALL = html(
  "tall",
  `<body style="margin:0;height:5000px"><input id=i>
<script>
window.__keys = [];
addEventListener("keydown", (e) => {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta"];
  window.__keys.push([...mods.filter(Boolean), e.key.toLowerCase()].join("+"));
}, true);
</script>`,
);

// The title follows the path, so a reload or a back to /spa reads right too.
const SPA = html(
  "spa",
  `<button id=push>push</button>
<script>
const sync = () => { document.title = location.pathname === "/spa/2" ? "spa-2" : "spa"; };
document.getElementById("push").onclick = () => { history.pushState({}, "", "/spa/2"); sync(); };
addEventListener("popstate", sync);
sync();
</script>`,
);

const POPUP = html(
  "popup",
  `<a id=blank target=_blank href=/page/tab>tab</a>
<button id=win onclick="window.open('/page/win', 'w', 'width=400,height=400')">win</button>
<button id=plain onclick="window.open('/page/plain')">plain</button>`,
);

const icon = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${color}"/></svg>`,
  )}`;

export async function startFixtures(): Promise<Fixtures> {
  const held = new Map<string, ServerResponse[]>();
  const released = new Set<string>();

  const send = (res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") => {
    // Nothing cached: a spec that loads a page twice means two requests.
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };

  const route = (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? "/", "http://fixtures");
    const [, head = "", rest = ""] = pathname.match(/^\/([^/]*)\/?(.*)$/) ?? [];
    const arg = decodeURIComponent(rest);

    switch (head) {
      case "page":
        return send(res, 200, html(arg, `<h1>${escape(arg)}</h1>`));
      case "tall":
        return send(res, 200, TALL);
      case "slow": {
        if (released.has(arg)) return send(res, 200, html(arg, `<h1>${escape(arg)}</h1>`));
        held.set(arg, [...(held.get(arg) ?? []), res]);
        // A request the browser gave up on must not be answered later.
        res.on("close", () => held.set(arg, (held.get(arg) ?? []).filter((r) => r !== res)));
        return;
      }
      case "redirect": {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1) return send(res, 400, "redirect needs a count of 1 or more");
        res.writeHead(302, { location: n === 1 ? "/page/final" : `/redirect/${n - 1}`, "cache-control": "no-store" });
        return res.end();
      }
      case "spa":
        return send(res, 200, SPA);
      case "popup":
        return send(res, 200, POPUP);
      case "popup-loop":
        return send(res, 200, html("popup-loop", "<script>setInterval(() => window.open('/page/spam'), 50)</script>"));
      case "close":
        return send(res, 200, html("close", "<button id=close onclick=window.close()>close</button>"));
      case "inline":
        return send(res, 200, html("inline", `<script>document.title = "inline-ran"</script>`));
      case "favicon":
        return send(res, 200, html(`favicon-${arg}`, `<link rel=icon href="${icon(arg)}">`));
      case "status": {
        const code = Number(arg);
        if (!Number.isInteger(code) || code < 200 || code > 599) return send(res, 400, "status needs 200-599");
        return send(res, code, "");
      }
      case "echo-headers":
        return send(res, 200, JSON.stringify(req.headers), "application/json");
      default:
        return send(res, 404, html("not found"));
    }
  };

  const server = createServer(route);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: (path) => new URL(path, origin).href,
    release(name) {
      released.add(name);
      for (const res of held.get(name) ?? []) send(res, 200, html(name, `<h1>${escape(name)}</h1>`));
      held.delete(name);
    },
    close() {
      for (const res of [...held.values()].flat()) res.destroy();
      held.clear();
      // Guests keep connections alive; close() alone would wait on them.
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
