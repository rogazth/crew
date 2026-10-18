/**
 * This Mac as the browser host of every machine in its address book. Each
 * machine gets its own link; over it main reports the tabs of that machine's
 * workspaces (strips live in this Mac's daemon, whatever their workspace),
 * and takes only calls on those tabs.
 *
 * The remote crewd already scopes every tool to the caller's workspace. The
 * gate here holds the same line on the side that has the user's signed-in
 * pages, so a machine that misbehaves still only reaches its own tabs, and
 * cannot make the window open a tab in another workspace.
 */

import type { BrowserHostPage, Workspace } from "../../src/lib/protocol";
import type { AgentTools, BrowserCall, Content } from "./agent-tools";
import { linkBrowserHost, type HostLink, type Hello } from "./host-link";

export type Machine = { id: string; name: string; url: string; token: string };

/** What one machine may drive: its workspaces, the tabs main told it of, and the ones it opened. */
export type Scope = {
  workspaces: ReadonlySet<string>;
  pages: ReadonlyMap<string, BrowserHostPage>;
  opened: Set<string>;
};

/** The workspace a strip belongs to: `<workspace>` or `<workspace>@<worktree path>`. */
export function workspaceOf(context: string): string {
  const at = context.indexOf("@");
  return at === -1 ? context : context.slice(0, at);
}

const notHere = (tab: string) => `There is no tab ${tab} in this workspace. list_tabs shows the ones there are.`;

/**
 * The call as it may run, or why it may not. A known tab's page is this
 * Mac's word on it, not the machine's. `taken` is whether a tab id is in use
 * on this Mac already: a machine may not open a "new" tab under an id that
 * is someone else's.
 */
export function gateCall(call: BrowserCall, scope: Scope, taken: (tab: string) => boolean): BrowserCall | string {
  const context = call.page?.context ?? "";
  if (call.tool === "open_tab") {
    if (!context || !scope.workspaces.has(workspaceOf(context))) return notHere(call.tab);
    if (scope.opened.has(call.tab)) return call;
    if (taken(call.tab)) return notHere(call.tab);
    scope.opened.add(call.tab);
    return call;
  }
  const page = scope.pages.get(call.tab);
  if (page) return { ...call, page: { context: page.context, url: page.url, title: page.title } };
  if (scope.opened.has(call.tab) && context && scope.workspaces.has(workspaceOf(context))) return call;
  return notHere(call.tab);
}

/** Seconds between dials of a machine that does not answer: 1, 2, 4, 8, then 15. */
export function remoteBackoff(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, Math.min(attempt - 1, 4)));
}

type Options = {
  tools: AgentTools;
  hello: Hello;
  /** The address book, with each machine's address and token. */
  machines: () => Promise<Machine[]>;
  /** Every tab in this Mac's strips. */
  localPages: () => Promise<BrowserHostPage[]>;
  /** Whether a tab id is in use on this Mac (a strip's, or a live guest's). */
  taken: (tab: string, pages: readonly BrowserHostPage[]) => boolean;
  onLeases: (machine: string, tabs: ReadonlySet<string>) => void;
  shrink?: (result: Content[]) => Content[];
  /** A machine just registered: tell it whether the user is here. */
  onReady?: (link: HostLink) => void;
};

type Entry = {
  machine: Machine;
  link: HostLink;
  scope: Scope;
  /** What it was last told, to skip sending the same list again. */
  sent: string | null;
  timer?: ReturnType<typeof setTimeout> | undefined;
};

const SYNC_MS = 250;
const MACHINES_MS = 15_000;

export function startRemoteHosts(options: Options) {
  const entries = new Map<string, Entry>();
  let lastPages: BrowserHostPage[] = [];
  let stopped = false;

  const sync = async (entry: Entry) => {
    entry.timer = undefined;
    if (!entry.link.ready()) return;
    try {
      const [pages, workspaces] = await Promise.all([options.localPages(), entry.link.request<Workspace[]>("workspace_list")]);
      lastPages = pages;
      const ids = new Set(workspaces.map((workspace) => workspace.id));
      const mine = pages.filter((page) => ids.has(workspaceOf(page.context)));
      entry.scope.workspaces = ids;
      entry.scope.pages = new Map(mine.map((page) => [page.pageId, page]));
      const body = JSON.stringify(mine);
      if (body === entry.sent) return;
      await entry.link.request("browser_host_pages", { pages: mine });
      entry.sent = body;
    } catch {
      // Down, or going down: the next registration sends it all again.
    }
  };

  const soon = (entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void sync(entry), SYNC_MS);
  };

  const open = (machine: Machine): Entry => {
    const entry: Entry = {
      machine,
      scope: { workspaces: new Set(), pages: new Map(), opened: new Set() },
      sent: null,
      link: null as unknown as HostLink,
    };
    entry.link = linkBrowserHost({
      info: () => machine,
      tools: options.tools,
      hello: options.hello,
      backoff: remoteBackoff,
      onLeases: (tabs) => options.onLeases(machine.id, tabs),
      gate: async (call) => {
        const check = () => gateCall(call, entry.scope, (tab) => options.taken(tab, lastPages) || taken(tab, entry));
        const first = check();
        if (typeof first !== "string") return first;
        // What main knows may be behind: a workspace made a moment ago, a strip
        // just saved, or a call that came in before the first report. Looked up
        // again once before saying no.
        await sync(entry);
        return check();
      },
      ...(options.shrink && { shrink: options.shrink }),
      onReady: () => {
        // A new connection is a new host to crewd: it starts with no pages.
        entry.sent = null;
        void sync(entry);
        options.onReady?.(entry.link);
      },
    });
    return entry;
  };

  /** A tab another machine opened is not this one's to open again. */
  const taken = (tab: string, asking: Entry) =>
    [...entries.values()].some((other) => other !== asking && (other.scope.opened.has(tab) || other.scope.pages.has(tab)));

  const refresh = async () => {
    const list = await options.machines().catch(() => null);
    if (!list || stopped) return;
    const wanted = new Map(list.map((machine) => [machine.id, machine]));
    for (const [id, entry] of entries) {
      const next = wanted.get(id);
      if (next && next.url === entry.machine.url && next.token === entry.machine.token) continue;
      entry.link.stop();
      if (entry.timer) clearTimeout(entry.timer);
      entries.delete(id);
      options.onLeases(id, new Set());
    }
    for (const [id, machine] of wanted) if (!entries.has(id)) entries.set(id, open(machine));
  };

  void refresh();
  const poll = setInterval(() => void refresh(), MACHINES_MS);

  return {
    /** This Mac's strips changed: each machine hears its own part. */
    pagesChanged: () => {
      for (const entry of entries.values()) soon(entry);
    },
    /** The address book may have changed. */
    refresh: () => void refresh(),
    links: (): HostLink[] => [...entries.values()].map((entry) => entry.link),
    pause: () => {
      for (const entry of entries.values()) entry.link.pause();
    },
    redial: () => {
      for (const entry of entries.values()) entry.link.redial();
    },
    stop: () => {
      stopped = true;
      clearInterval(poll);
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.link.stop();
      }
      entries.clear();
    },
  };
}
