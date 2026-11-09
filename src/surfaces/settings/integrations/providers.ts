// The servers each provider CLI already has, per machine: the lists the
// machine's daemon reads from its CLIs (`provider_servers_list`, then every
// `provider-servers` event from that machine), and what this window is doing
// to them. Every call goes to that machine's daemon, since its CLIs keep their
// own configs and sign-ins; the caught redirect of a sign-in goes there too.
// The pure reading of the lists is servers.ts.
import { useEffect, useSyncExternalStore } from "react";
import {
  onProviderServers,
  providerServerCallback,
  providerServerOff,
  providerServerRemove,
  providerServerSignIn,
  providerServerSignInCancel,
  providerServersList,
  registryMatch,
} from "../../../lib/api";
import { client } from "../../../lib/client";
import { LOCAL } from "../../../lib/client/registry";
import { openUrl } from "../../../lib/host";
import type { ProviderInventory, RegistryServer } from "../../../lib/protocol";
import { openServerSignIn } from "../../../lib/remoteUi";
import { runSignIn } from "../../../lib/signInWindow";
import { toast } from "../ui";
import { isBundled, isOff, serverKey, type Busy, type RegistryOf, type Server } from "./servers";

/** One machine's lists, as last read. */
export type MachineServers = {
  loaded: boolean;
  /** Why the lists could not be read last time. */
  error: string | null;
  inventory: ProviderInventory[];
};

/** A sign-in or a new try this window has under way, for one server on one machine. */
type Work = { id: number; envId: string; key: string; busy: Exclude<Busy, null> };

type State = {
  machines: Record<string, MachineServers>;
  work: Work[];
  /** The registry server each remote URL is, by URL; `null` when it is none the registry knows. */
  registry: Record<string, RegistryServer | null>;
  /** The URLs asked of the registry whose answer is on its way. */
  matching: ReadonlySet<string>;
};

let state: State = { machines: {}, work: [], registry: {}, matching: new Set() };
const listeners = new Set<() => void>();

function set(next: (s: State) => State) {
  state = next(state);
  listeners.forEach((l) => l());
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How long a row waits for its machine to say a sign-in or a new try took, before it shows the list as it is. */
const SETTLE_MS = 20_000;

/* ── Reading ──────────────────────────────────────────────────────── */

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  onProviderServers((inventory, envId) => put(envId, inventory));
  // A machine that came back may have changed while away.
  client.onReconnect(() => {
    for (const envId of Object.keys(state.machines)) void load(envId, false);
  });
}

/** Asks this Mac's copy of the registry what the URLs not asked yet are, so a server shows its real name and mark. */
async function matchRegistry(inventory: ProviderInventory[]) {
  const urls = [
    ...new Set(
      inventory
        .flatMap((i) => i.servers.map((x) => x.target))
        .filter((t) => /^https?:\/\//.test(t) && !(t in state.registry) && !state.matching.has(t)),
    ),
  ];
  if (urls.length === 0) return;
  // Asked once while the answer is on its way; a failed ask is forgotten, so the next list asks again.
  set((s) => ({ ...s, matching: new Set([...s.matching, ...urls]) }));
  const found = await registryMatch(urls).catch(() => null);
  const matching = (s: State) => new Set([...s.matching].filter((url) => !urls.includes(url)));
  if (found === null) return set((s) => ({ ...s, matching: matching(s) }));
  const servers = new Map(found.map((m) => [m.url, m.server]));
  set((s) => ({
    ...s,
    matching: matching(s),
    registry: { ...s.registry, ...Object.fromEntries(urls.map((url) => [url, servers.get(url) ?? null])) },
  }));
}

/** A machine's new lists: rows waiting on a sign-in or a try let go once the machine has moved on. */
function put(envId: string, inventory: ProviderInventory[]) {
  void matchRegistry(inventory);
  const servers = new Map(inventory.flatMap((i) => i.servers.map((x): [string, Server] => [serverKey(x), x])));
  const checking = new Set(inventory.filter((i) => i.checking).map((i) => i.provider));
  const done = state.work.filter((w) => {
    if (w.envId !== envId) return false;
    const server = servers.get(w.key);
    if (!server) return w.busy !== "signing-in";
    if (w.busy === "starting") return server.state !== "needs_auth";
    if (w.busy === "checking") return !checking.has(server.provider);
    return false;
  });
  set((s) => ({
    ...s,
    machines: { ...s.machines, [envId]: { loaded: true, error: null, inventory } },
    work: s.work.filter((w) => !done.includes(w)),
  }));
}

async function load(envId: string, refresh: boolean) {
  try {
    put(envId, await providerServersList(envId, refresh));
  } catch (error) {
    set((s) => {
      const was = s.machines[envId];
      return { ...s, machines: { ...s.machines, [envId]: { loaded: true, error: message(error), inventory: was?.inventory ?? [] } } };
    });
  }
}

/** Machines asked to read their CLIs again since the window opened. */
const read = new Set<string>();

/** The first look at a machine in this window reads its CLIs again; later ones take the lists it has. */
function ensure(envId: string) {
  hook();
  const first = !read.has(envId);
  read.add(envId);
  void load(envId, first);
}

export type MachineView = MachineServers & {
  /** What this window is doing to a server, by its key. */
  busy: (server: Server) => Busy;
  registryOf: RegistryOf;
  /**
   * Loaded, and the registry has answered for every URL in the lists: until
   * then copies of one server under different names would show apart, then
   * merge, so the page waits for both.
   */
  settled: boolean;
};

const EMPTY: MachineServers = { loaded: false, error: null, inventory: [] };

/** One machine's servers, read when the page first shows it and kept up from its events. */
export function useProviderServers(envId: string): MachineView {
  useEffect(() => ensure(envId), [envId]);
  const s = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  const machine = s.machines[envId] ?? EMPTY;
  return {
    ...machine,
    busy: (server) => s.work.find((w) => w.envId === envId && w.key === serverKey(server))?.busy ?? null,
    registryOf: (server) => s.registry[server.target] ?? undefined,
    settled: machine.loaded && !machine.inventory.some((i) => i.servers.some((x) => s.matching.has(x.target))),
  };
}

let primed = false;
/**
 * Follows every machine's lists, taking this Mac's as the daemon read them
 * when it started; reading the CLIs again is left to the page's first look.
 */
export function subscribeServers(listener: () => void): () => void {
  hook();
  if (!primed) {
    primed = true;
    void load(LOCAL, false);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a CLI's server on a machine whose lists this window has waits on a sign-in: Settings' Connectors wears a dot. */
export function serversNeedYou(): boolean {
  return Object.values(state.machines).some((m) => m.inventory.some((i) => i.servers.some((x) => !isOff(x) && !isBundled(x) && x.state === "needs_auth")));
}

/** Every machine's lists this window has, and what it is doing to their servers. */
export function useAllMachines(): { machines: Record<string, MachineServers>; busy: (envId: string, server: Server) => Busy } {
  const s = useSyncExternalStore(
    (listener) => {
      hook();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  return {
    machines: s.machines,
    busy: (envId, server) => s.work.find((w) => w.envId === envId && w.key === serverKey(server))?.busy ?? null,
  };
}

/** A machine's lists as it has them now, after a change made to them. */
export const reloadMachine = (envId: string) => load(envId, false);

/* ── Writing ──────────────────────────────────────────────────────── */

let workSeq = 0;

function begin(envId: string, server: Server, busy: Work["busy"]): number {
  const id = ++workSeq;
  const key = serverKey(server);
  set((s) => ({ ...s, work: [...s.work.filter((w) => !(w.envId === envId && w.key === key)), { id, envId, key, busy }] }));
  return id;
}

function shift(id: number, busy: Work["busy"]) {
  set((s) => ({ ...s, work: s.work.map((w) => (w.id === id ? { ...w, busy } : w)) }));
}

function end(id: number) {
  set((s) => ({ ...s, work: s.work.filter((w) => w.id !== id) }));
}

/** Lets a row go after a while even if its machine never says: it then shows the list as it is. */
function settleLater(id: number) {
  window.setTimeout(() => end(id), SETTLE_MS);
}

function patch(envId: string, key: string, change: (server: Server) => Server) {
  set((s) => {
    const machine = s.machines[envId];
    if (!machine) return s;
    const inventory = machine.inventory.map((i) => ({ ...i, servers: i.servers.map((x) => (serverKey(x) === key ? change(x) : x)) }));
    return { ...s, machines: { ...s.machines, [envId]: { ...machine, inventory } } };
  });
}

const CLAUDE_AI_CONNECTORS = "https://claude.ai/settings/connectors";

export const serverActions = {
  /**
   * Signs a server in on the machine whose CLI uses it. A page opens in the
   * sign-in window, and the redirect it catches goes to that machine's daemon;
   * a CLI that signs in only on its own gets a terminal tab on that machine,
   * whose end reads the lists again. The row says Authenticating…, then
   * Starting…, until the machine reports the server again.
   */
  signIn(envId: string, server: Server) {
    const ref = { provider: server.provider, name: server.name };
    const id = begin(envId, server, "signing-in");
    void (async () => {
      let started: string | null = null;
      try {
        const how = await providerServerSignIn(envId, ref);
        if (how.kind === "terminal") {
          end(id);
          await openServerSignIn(envId, { provider: server.provider, server: server.name, command: how.command });
          return;
        }
        started = how.state;
        const outcome = await runSignIn(how, {
          deliver: (url) => providerServerCallback(envId, how.state, url),
          cancel: () => providerServerSignInCancel(envId, how.state),
        });
        if (outcome.kind === "closed") return end(id);
        // Signed in: the row starts the server in place until the machine reports it.
        shift(id, "starting");
        settleLater(id);
        void load(envId, false);
      } catch (error) {
        end(id);
        if (started) void providerServerSignInCancel(envId, started).catch(() => {});
        toast(`Couldn’t sign in to ${server.name}: ${message(error)}`, "danger");
      }
    })();
  },

  /** A claude.ai connector is signed in at claude.ai. */
  openClaudeAi() {
    void openUrl(CLAUDE_AI_CONNECTORS);
  },

  /** A server that didn't start: the machine reads its CLIs again, which starts it once more. */
  retry(envId: string, server: Server) {
    const id = begin(envId, server, "checking");
    settleLater(id);
    void load(envId, true);
  },

  /** Leaves a server out of Crew's sessions on that machine, or puts it back; shown at once and put back if refused. */
  setOff(envId: string, server: Server, off: boolean) {
    const key = serverKey(server);
    patch(envId, key, (x) => ({ ...x, offInCrew: off }));
    providerServerOff(envId, { provider: server.provider, name: server.name }, off).catch((error: unknown) => {
      patch(envId, key, (x) => ({ ...x, offInCrew: !off }));
      toast(`Couldn’t ${off ? "turn" : "turn back"} ${server.name} ${off ? "off" : "on"}: ${message(error)}`, "danger");
    });
  },

  /** Takes a server out of its CLI's config: the row says Removing… until the CLI has, then leaves the list. */
  remove(envId: string, server: Server) {
    const key = serverKey(server);
    const id = begin(envId, server, "removing");
    providerServerRemove(envId, { provider: server.provider, name: server.name }).then(
      () => {
        set((s) => {
          const machine = s.machines[envId];
          if (!machine) return s;
          const inventory = machine.inventory.map((i) => ({ ...i, servers: i.servers.filter((x) => serverKey(x) !== key) }));
          return { ...s, machines: { ...s.machines, [envId]: { ...machine, inventory } } };
        });
        end(id);
      },
      (error: unknown) => {
        end(id);
        toast(`Couldn’t remove ${server.name}: ${message(error)}`, "danger");
      },
    );
  },

  /** Asks the machine to read its CLIs again. */
  refresh(envId: string) {
    void load(envId, true);
  },
};
