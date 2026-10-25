/**
 * The sign-ins the window started, as pure decisions. A sign-in opens in a
 * window of its own (sign-in-window.ts); the service sends it back to a
 * loopback redirect URI, and the navigation there is caught, cancelled, and
 * its URL handed back to the renderer, which gives it to the daemon that
 * holds the flow: this Mac's vault for a connector, or the machine whose CLI
 * started a provider server's sign-in. The URI may be Crew's own or a CLI's
 * loopback listener on any port; either way nothing on this Mac is asked for
 * it, so the code never reaches a socket. Only a window opened for a flow,
 * and the popups it opens, belong to one: a tab, an agent's included, that
 * lands on the same URI is left alone, so no page can finish a sign-in the
 * person did not start.
 */

import type { SignInRequest } from "../../src/lib/browser/bridge";

export type PendingFlow = { state: string; redirectUri: string };

/**
 * An OAuth state, long enough to be unguessable: unreserved URL characters,
 * and base64's `+/=`, since a CLI's own flow mints its state its own way.
 */
const STATE = /^[A-Za-z0-9._~+/=-]{8,256}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return LOOPBACK.has(url.hostname);
}

/** A redirect URI to catch: plain http on loopback, with a port (Crew's own or a CLI's listener), and nothing after the path. */
function redirectUriOk(value: string): boolean {
  const url = parse(value);
  return !!url && url.protocol === "http:" && isLoopback(url) && url.port !== "" && url.search === "" && url.hash === "" && !url.username && !url.password;
}

/** Where a sign-in may start: the service's page over https; plain http only on loopback (a fake server in tests). */
function authUrlOk(value: string): boolean {
  const url = parse(value);
  if (!url || url.username || url.password) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url));
}

/** Keeps only a well-formed request: this arrives from the renderer. */
export function signInRequest(value: unknown): SignInRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { state, authUrl, redirectUri, incognito } = value as Partial<Record<keyof SignInRequest, unknown>>;
  if (typeof state !== "string" || !STATE.test(state)) return null;
  if (typeof authUrl !== "string" || authUrl.length > 8192 || !authUrlOk(authUrl)) return null;
  if (typeof redirectUri !== "string" || redirectUri.length > 2048 || !redirectUriOk(redirectUri)) return null;
  return { state, authUrl, redirectUri, incognito: incognito === true };
}

/** Whether `url` goes to the flow's redirect URI: the same origin and path, whatever its query. */
export function landsOn(url: string, redirectUri: string): boolean {
  const target = parse(url);
  const redirect = parse(redirectUri);
  if (!target || !redirect) return false;
  return target.protocol === redirect.protocol && target.host === redirect.host && target.pathname === redirect.pathname;
}

export type RedirectDecision =
  /** Not this flow's redirect, or no flow's page: the navigation goes on. */
  | { action: "pass" }
  /** The flow's redirect with its own state: cancel it and hand the URL over. */
  | { action: "catch"; state: string; url: string }
  /** The flow's redirect with another state, or none: cancel it, and the flow fails. */
  | { action: "refuse"; state: string };

/**
 * What a navigation (or a request) to `url` from a page means. `flow` is the
 * flow the page was opened for, null for every other page.
 */
export function redirectDecision(url: string, flow: PendingFlow | null): RedirectDecision {
  if (!flow || !landsOn(url, flow.redirectUri)) return { action: "pass" };
  const state = parse(url)?.searchParams.get("state");
  return state === flow.state ? { action: "catch", state: flow.state, url } : { action: "refuse", state: flow.state };
}

/**
 * The pages that belong to a flow, by webContents id: its window and the
 * popups that window opens. Settles each flow once, whichever event sees the
 * redirect first.
 */
export class FlowRegistry<T extends PendingFlow = PendingFlow> {
  private readonly byContents = new Map<number, T>();
  private readonly byState = new Map<string, T>();

  start(contentsId: number, flow: T): void {
    this.byState.set(flow.state, flow);
    this.byContents.set(contentsId, flow);
  }

  /** A popup the flow's window opened belongs to the flow too. */
  adopt(contentsId: number, state: string): void {
    const flow = this.byState.get(state);
    if (flow) this.byContents.set(contentsId, flow);
  }

  /** A page that went away; its flow stays while its window does. */
  forget(contentsId: number): void {
    this.byContents.delete(contentsId);
  }

  flowOf(contentsId: number | undefined): T | null {
    if (contentsId === undefined) return null;
    const flow = this.byContents.get(contentsId);
    // A settled flow's pages no longer catch anything.
    return flow && this.byState.get(flow.state) === flow ? flow : null;
  }

  get(state: string): T | null {
    return this.byState.get(state) ?? null;
  }

  /** Ends the flow; answers whether it was still pending, so its outcome is delivered once. */
  settle(state: string): boolean {
    const flow = this.byState.get(state);
    if (!flow) return false;
    this.byState.delete(state);
    for (const [id, owned] of this.byContents) if (owned === flow) this.byContents.delete(id);
    return true;
  }

  decide(contentsId: number | undefined, url: string): RedirectDecision {
    return redirectDecision(url, this.flowOf(contentsId));
  }
}
