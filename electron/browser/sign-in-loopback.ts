/**
 * The sign-ins that happen in the person's own browser (Google's: it refuses
 * an embedded user agent, see `opensInSystemBrowser`). Crew opens the page in
 * the default browser and listens on the flow's loopback redirect URI, on
 * 127.0.0.1 alone, only while such a flow is pending.
 *
 * One listener serves every pending flow, each known by its state, so a second
 * Google app started meanwhile doesn't cancel the first. A request that isn't
 * a pending flow's redirect gets a plain 404 and changes nothing: any page the
 * person has open can reach this port, so it must not be able to end a flow.
 *
 * The URL holds the authorization code: it goes to the flow's caller and
 * nowhere else, never to a log. No Electron here, so tests run it for real.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SignInOutcome } from "../../src/lib/browser/bridge";
import { loopbackDecision, type PendingFlow } from "./sign-in-flows";

/** As long as the daemon keeps the flow (`FLOW_TTL_MS` in flow.rs): past it, the code could not be redeemed. */
const SIGN_IN_TTL_MS = 15 * 60 * 1000;

const BACK_TO_CREW = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Back to Crew</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; margin: 0; padding: 16px; text-align: center; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  p { margin: 0; opacity: .7; }
</style>
<h1>Go back to Crew</h1>
<p>Crew has the answer from your sign-in. You can close this tab.</p>
</html>
`;

type Pending = PendingFlow & { finish: (outcome: SignInOutcome) => void; timer: ReturnType<typeof setTimeout> };

export type LoopbackOptions = {
  port: number;
  /** Shows the page in the person's browser. */
  open: (url: string) => Promise<void>;
  ttlMs?: number;
};

export class LoopbackSignIns {
  private readonly port: number;
  private readonly open: (url: string) => Promise<void>;
  private readonly ttlMs: number;
  private readonly pending = new Map<string, Pending>();
  private server: Server | null = null;
  private listening: Promise<void> | null = null;
  /** The last listener going away: the next one waits for the port. */
  private closing: Promise<void> = Promise.resolve();
  /** Pages on their way to the browser: the port stays open until they arrive. */
  private answering = 0;

  constructor(options: LoopbackOptions) {
    this.port = options.port;
    this.open = options.open;
    this.ttlMs = options.ttlMs ?? SIGN_IN_TTL_MS;
  }

  /**
   * Listens, opens the page and resolves once the flow ends. Nothing here
   * rejects: what went wrong is the outcome. A state already pending ends
   * that flow as well: nobody can tell which of the two the redirect is for.
   */
  start(request: { state: string; authUrl: string; redirectUri: string }): Promise<SignInOutcome> {
    if (this.pending.has(request.state)) {
      this.abort(request.state);
      return Promise.resolve({ kind: "closed" });
    }
    return new Promise<SignInOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(request.state, { kind: "failed", message: "The sign-in in your browser took too long. Try again." }), this.ttlMs);
      timer.unref?.();
      this.pending.set(request.state, { state: request.state, redirectUri: request.redirectUri, finish: resolve, timer });
      void this.begin(request.state, request.authUrl);
    });
  }

  /** Ends a pending flow as closed: cancelled, or Crew's window went away. */
  abort(state: string): void {
    this.settle(state, { kind: "closed" });
  }

  private async begin(state: string, authUrl: string): Promise<void> {
    await this.listen();
    // Failed to listen, or aborted meanwhile.
    if (!this.pending.has(state)) return this.closeIfIdle();
    try {
      await this.open(authUrl);
    } catch {
      this.settle(state, { kind: "failed", message: "Couldn’t open your browser. Try again." });
    }
  }

  private settle(state: string, outcome: SignInOutcome): void {
    const flow = this.pending.get(state);
    if (!flow) return;
    this.pending.delete(state);
    clearTimeout(flow.timer);
    flow.finish(outcome);
    this.closeIfIdle();
  }

  private listen(): Promise<void> {
    this.listening ??= this.closing.then(
      () =>
        new Promise<void>((resolve) => {
          const server = createServer((req, res) => this.answer(req, res));
          server.on("error", (error: NodeJS.ErrnoException) => {
            this.broke(server, error);
            resolve();
          });
          server.listen(this.port, "127.0.0.1", () => {
            this.server = server;
            resolve();
          });
        }),
    );
    return this.listening;
  }

  /** The port can't be had, or stopped working: every flow waiting on it ends, and says why. */
  private broke(server: Server, error: NodeJS.ErrnoException): void {
    if (this.server === server) this.server = null;
    this.listening = null;
    const message =
      error.code === "EADDRINUSE"
        ? `Port ${this.port} on this Mac is in use, and the sign-in needs it to come back to Crew. Quit whatever holds it (another copy of Crew, maybe) and try again.`
        : `Couldn’t wait for the sign-in on port ${this.port} (${error.code ?? "unknown error"}). Try again.`;
    for (const state of [...this.pending.keys()]) this.settle(state, { kind: "failed", message });
  }

  /** Lets the port go once no flow needs it. A listener still coming up is checked again by `begin`. */
  private closeIfIdle(): void {
    const server = this.server;
    if (!server || this.pending.size > 0 || this.answering > 0) return;
    this.server = null;
    this.listening = null;
    this.closing = new Promise((resolve) => server.close(() => resolve()));
    // A browser's idle connections would otherwise hold the port.
    server.closeAllConnections();
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    const decision = loopbackDecision(this.urlOf(req), this.pending);
    if (decision.action !== "catch") {
      reply(res, 404, "text/plain; charset=utf-8", "Not found.\n");
      return;
    }
    this.answering += 1;
    res.once("close", () => {
      this.answering -= 1;
      this.closeIfIdle();
    });
    reply(res, 200, "text/html; charset=utf-8", BACK_TO_CREW);
    this.settle(decision.state, { kind: "caught", url: decision.url });
  }

  /**
   * The URL a request asked for, or "" when it can't be a redirect. The Host
   * must be this very address: a site that rebinds its own name to 127.0.0.1
   * reaches the port too, but under its name.
   */
  private urlOf(req: IncomingMessage): string {
    const authority = `127.0.0.1:${this.port}`;
    if (req.method !== "GET" || req.headers.host !== authority) return "";
    try {
      return new URL(req.url ?? "/", `http://${authority}`).href;
    } catch {
      return "";
    }
  }
}

function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    Connection: "close",
  });
  res.end(body);
}
