// The servers each provider CLI already has, per machine: the lists the
// machine's daemon reads from its CLIs (`provider_servers_list`, then every
// `provider-servers` event from that machine), and what this window is doing
// to them. Every call goes to that machine's daemon, since its CLIs keep their
// own configs and sign-ins; the caught redirect of a sign-in goes there too.
// Whether a server is on in Crew is one choice for every machine: a global
// setting (lib/serverChoices.ts), written to each machine's daemon whenever its
// lists arrive and a copy there says otherwise, so a machine that was away
// catches up once it is back. The pure reading of the lists is servers.ts.
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
import { useEnvStates } from "../../../hooks/useEnvLinks";
import { EnvDown, LOCAL, onConnected, type EnvLink } from "../../../lib/client/registry";
import { openUrl } from "../../../lib/host";
import type { ProviderInventory, RegistryServer } from "../../../lib/protocol";
import { serverChoicesSetting } from "../../../lib/serverChoices";
import { peekSetting, readSetting, saveSetting, watchSetting } from "../../../lib/settingsEngine/store";
import { openServerSignIn } from "../../../lib/remoteUi";
import { runSignIn } from "../../../lib/signInWindow";
import { toast } from "../ui";
import { drifted, groupsOf, isBundled, isOff, serverKey, servicesOf, type Busy, type Choices, type RegistryOf, type Server, type Service } from "./servers";

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
  /** On or off in Crew, by service; null until read from this Mac. */
  choices: Choices | null;
};

let state: State = { machines: {}, work: [], registry: {}, matching: new Set(), choices: null };
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
  // A machine this window hasn't read yet may hold copies that missed a choice made while it was away.
  onConnected((envId) => {
    if (state.choices && Object.keys(state.choices).length > 0 && !state.machines[envId]) void load(envId, false);
  });
  watchSetting(serverChoicesSetting, takeChoices);
  readSetting(serverChoicesSetting).then(takeChoices, takeChoices);
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
  reconcileAll();
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
  reconcile(envId);
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

const registryIn =
  (s: State): RegistryOf =>
  (server) =>
    s.registry[server.target] ?? undefined;

const busyIn = (s: State, envId: string, server: Server): Busy => s.work.find((w) => w.envId === envId && w.key === serverKey(server))?.busy ?? null;

/** Loaded, and the registry has answered for every URL in its lists. */
const settledIn = (s: State, envId: string): boolean => {
  const machine = s.machines[envId];
  return !!machine?.loaded && !machine.inventory.some((i) => i.servers.some((x) => s.matching.has(x.target)));
};

function useStore(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** One machine's servers, read when the page first shows it and kept up from its events. */
export function useProviderServers(envId: string): MachineView {
  useEffect(() => ensure(envId), [envId]);
  const s = useStore();
  const machine = s.machines[envId] ?? EMPTY;
  return {
    ...machine,
    busy: (server) => busyIn(s, envId, server),
    registryOf: registryIn(s),
    settled: settledIn(s, envId),
  };
}

export type ServicesView = {
  services: Service[];
  /** Every machine asked has answered (or failed to), and the registry has named their servers. */
  settled: boolean;
  machines: Record<string, MachineServers>;
  choices: Choices;
  busy: (envId: string, server: Server) => Busy;
};

/** Every server on these machines as one list, read when the page first shows each machine. */
export function useServices(envIds: string[]): ServicesView {
  const ids = envIds.join("\u0000");
  useEffect(() => {
    for (const envId of ids.split("\u0000")) if (envId) ensure(envId);
  }, [ids]);
  const s = useStore();
  const present = envIds.map((envId) => ({ envId, inventory: s.machines[envId]?.inventory ?? [] }));
  return {
    services: servicesOf(present, registryIn(s)),
    settled: s.choices !== null && envIds.every((envId) => settledIn(s, envId)),
    machines: s.machines,
    choices: s.choices ?? {},
    busy: (envId, server) => busyIn(s, envId, server),
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
    busy: (envId, server) => busyIn(s, envId, server),
  };
}

/** A machine's name as the page says it. */
export const machineName = (link: EnvLink | undefined, envId: string) => (envId === LOCAL ? "This Mac" : (link?.name ?? envId));

/** This Mac's daemon is the window's own; only a remote is ever away. */
export const machineLive = (link: EnvLink | undefined, envId: string) => envId === LOCAL || (link?.status === "online" && !link.mismatch);

/** Every machine the window knows, this Mac first; just this Mac until the links are up. */
export function useMachines(): { links: EnvLink[]; ids: string[] } {
  const links = useEnvStates();
  const ids = links.length > 0 ? [LOCAL, ...links.map((l) => l.id).filter((id) => id !== LOCAL)] : [LOCAL];
  return { links, ids };
}

/* ── On or off in Crew, everywhere ─────────────────────────────────── */

/** The choices as they stand now, from here or another window: copies that don't follow them are written to. */
function takeChoices() {
  const choices = peekSetting(serverChoicesSetting);
  if (choices === state.choices) return;
  set((s) => ({ ...s, choices }));
  written.clear();
  reconcileAll();
}

/**
 * Copies already written toward a choice in this window, so a machine that
 * keeps saying otherwise isn't written to again on every list. A new choice
 * starts over.
 */
const written = new Set<string>();

/** Writes the choices to one machine's copies that don't follow them yet. */
function reconcile(envId: string) {
  const choices = state.choices;
  // A registry server's key is only known once the registry has answered, so until then nothing is written.
  if (!choices || !settledIn(state, envId)) return;
  for (const group of groupsOf(state.machines[envId]!.inventory, registryIn(state))) {
    const on = choices[group.key];
    if (on === undefined) continue;
    for (const server of drifted(group, on)) {
      const mark = `${envId}\u0000${serverKey(server)}\u0000${on}`;
      if (written.has(mark)) continue;
      written.add(mark);
      writeOff(envId, server, !on, mark);
    }
  }
}

function reconcileAll() {
  for (const envId of Object.keys(state.machines)) reconcile(envId);
}

/**
 * Puts a server on or off in Crew on every machine: at once on the machines
 * this window has read, and on any other the next time its lists arrive.
 */
export function setServiceOn(key: string, on: boolean) {
  saveSetting(serverChoicesSetting, { ...peekSetting(serverChoicesSetting), [key]: on });
  takeChoices();
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

/**
 * Leaves a copy out of Crew's sessions on its machine, or puts it back; shown
 * at once and put back if refused. A machine that is away is written to again
 * once its lists arrive, so only a refusal is said.
 */
function writeOff(envId: string, server: Server, off: boolean, mark: string) {
  const key = serverKey(server);
  patch(envId, key, (x) => ({ ...x, offInCrew: off }));
  providerServerOff(envId, { provider: server.provider, name: server.name }, off).catch((error: unknown) => {
    written.delete(mark);
    patch(envId, key, (x) => ({ ...x, offInCrew: !off }));
    if (!(error instanceof EnvDown)) toast(`Couldn’t ${off ? "turn" : "turn back"} ${server.name} ${off ? "off" : "on"}: ${message(error)}`, "danger");
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
