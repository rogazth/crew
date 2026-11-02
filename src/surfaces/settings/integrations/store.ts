// The Connectors page's model: Crew's connectors and their accounts as this
// Mac's vault keeps them (`connectors_list`, then every `connectors` event),
// the workspaces an account can be for, and the sign-ins
// this window has running. Every action is a daemon call; the few that a
// switch makes are shown at once and put back if the daemon refuses.
// See docs/plans/2026-10-23-integrations.md.
import { useSyncExternalStore } from "react";
import {
  accountRefresh,
  accountRemove,
  accountRename,
  accountWorkspacesSet,
  builtinList,
  connectorAdd,
  connectorConnect,
  connectorRemove,
  connectorsList,
  onConnectors,
  signInCancel,
  toolSet,
  vaultCallback,
} from "../../../lib/api";
import { abortSignIn, catchRedirect } from "../../../lib/signInWindow";
import { ensureMembers, loadVault, watchMembers } from "./vault";
import type { BuiltinConnector, Connector, ConnectorAccount, RegistryServer, SignIn } from "../../../lib/protocol";
import { toast } from "../ui";

export type Account = ConnectorAccount;
export type AccountState = Account["state"];

/** A workspace an account can be for. */
export type Place = { id: string; name: string };

/** A sign-in this window started: the window opens, the person consents, the daemon redeems the code. */
export type FlowStage = "opening" | "waiting" | "redeeming" | "done" | "failed";
export type Flow = {
  id: number;
  connectorId: string;
  /** Known once the daemon has made (or picked) the account. */
  accountId: string | null;
  stage: FlowStage;
  /** Why it failed, in one line. */
  error?: string | undefined;
};

export type State = {
  loaded: boolean;
  /** Why the list could not be read. */
  error: string | null;
  connectors: Connector[];
  /** What Crew builds in, installed or not: Browse lists them above the registry. */
  builtins: BuiltinConnector[];
  /** The app's workspaces, as the page last saw them. */
  workspaces: Place[];
  flows: Flow[];
};

let state: State = { loaded: false, error: null, connectors: [], builtins: [], workspaces: [], flows: [] };
const listeners = new Set<() => void>();

function set(next: (s: State) => State) {
  state = next(state);
  listeners.forEach((l) => l());
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

let started = false;
/** The first reader loads the list and follows the daemon's changes for as long as the window lives. */
function start() {
  if (started) return;
  started = true;
  onConnectors((connectors) => set((s) => ({ ...s, loaded: true, error: null, connectors })));
  // Read from the vault, wherever it is; the machines online lease from it.
  void loadVault().then(() => {
    void reload();
    void ensureMembers();
    watchMembers();
  });
}

/** The list and the built-ins, again: after the vault moved, from its new place. */
export async function reload() {
  await load();
  await builtinList()
    .then((builtins) => set((s) => ({ ...s, builtins })))
    .catch(() => {});
}

async function load() {
  try {
    const connectors = await connectorsList();
    set((s) => ({ ...s, loaded: true, error: null, connectors }));
  } catch (error) {
    set((s) => ({ ...s, loaded: true, error: message(error) }));
  }
}

export function useIntegrations(): State {
  return useSyncExternalStore(
    (listener) => {
      start();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** An account that waits on the person: signed out, short of a permission, or refused. A sign-in never finished is not one. */
const NEEDS_YOU: ReadonlySet<AccountState> = new Set(["expired", "needs-scope", "failed"]);

/** Whether a connector has an account that needs the person: the rail's Connectors icon wears a dot. */
export const accountsNeedYou = (s: State) => s.connectors.some((c) => c.accounts.some((a) => NEEDS_YOU.has(a.state)));

/** Follows the connectors, loading them the first time, for a view that reads only a part of them. */
export function subscribeConnectors(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): State {
  return state;
}

export function setWorkspaces(workspaces: Place[]) {
  if (JSON.stringify(workspaces) === JSON.stringify(state.workspaces)) return;
  set((s) => ({ ...s, workspaces }));
}

/* ── Writing back what the daemon answered ─────────────────────────────── */

function putConnector(connector: Connector) {
  set((s) => ({
    ...s,
    connectors: s.connectors.some((c) => c.id === connector.id)
      ? s.connectors.map((c) => (c.id === connector.id ? connector : c))
      : [...s.connectors, connector],
  }));
}

function putAccount(account: Account) {
  set((s) => ({
    ...s,
    connectors: s.connectors.map((c) =>
      c.id !== account.connectorId
        ? c
        : {
            ...c,
            accounts: c.accounts.some((a) => a.id === account.id)
              ? c.accounts.map((a) => (a.id === account.id ? account : a))
              : [...c.accounts, account],
          },
    ),
  }));
}

function patchAccount(accountId: string, patch: (a: Account) => Account) {
  set((s) => ({
    ...s,
    connectors: s.connectors.map((c) => ({ ...c, accounts: c.accounts.map((a) => (a.id === accountId ? patch(a) : a)) })),
  }));
}

/** A change shown before the daemon has it: put back, and said, if it refuses. */
async function optimistic(apply: () => void, call: () => Promise<unknown>, failure: string) {
  const before = state.connectors;
  apply();
  try {
    await call();
  } catch (error) {
    set((s) => ({ ...s, connectors: before }));
    toast(`${failure}: ${message(error)}`, "danger");
  }
}

/* ── Sign-ins ─────────────────────────────────────────────────────────── */

let flowSeq = 0;

function stage(id: number, patch: Partial<Flow>) {
  set((s) => ({ ...s, flows: s.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
}

/** The states of the sign-ins in flight, so closing the page's sheet can't orphan one. */
const running = new Map<number, string>();

/** The account each finished sign-in landed on, kept after its flow is let go. */
const landed = new Map<number, string>();

/**
 * A sign-in, start to end: a new account of the connector, or `accountId`
 * again. Resolves the flow's id at once; the flow itself moves on in the store.
 */
function signIn(connectorId: string, accountId: string | null, loginHint: string | null = null, workspaces: string[] | null = null): number {
  const id = ++flowSeq;
  set((s) => ({
    ...s,
    // A new try replaces the one that failed before it.
    flows: [
      ...s.flows.filter((f) => !(f.stage === "failed" && f.connectorId === connectorId && (accountId === null || f.accountId === accountId))),
      { id, connectorId, accountId, stage: "opening" },
    ],
  }));
  void (async () => {
    let started: SignIn | null = null;
    try {
      started = await connectorConnect({ connectorId, accountId, label: null, loginHint, workspaces });
      running.set(id, started.state);
      stage(id, { accountId: started.accountId, stage: "waiting" });
      // The window catches the redirect itself; this Mac's vault redeems it.
      const url = await catchRedirect(started);
      running.delete(id);
      if (url === null) {
        await signInCancel(started.state).catch(() => {});
        stage(id, { stage: "failed", error: "The sign-in window was closed." });
        return;
      }
      stage(id, { stage: "redeeming" });
      const account = await vaultCallback(started.state, url);
      putAccount(account);
      landed.set(id, account.id);
      stage(id, { stage: "done", accountId: account.id });
      window.setTimeout(() => set((s) => ({ ...s, flows: s.flows.filter((f) => f.id !== id) })), 1400);
    } catch (error) {
      running.delete(id);
      if (started) void signInCancel(started.state).catch(() => {});
      stage(id, { stage: "failed", error: message(error) });
    }
  })();
  return id;
}

export function dismissFlow(id: number) {
  const pending = running.get(id);
  if (pending) abortSignIn(pending);
  set((s) => ({ ...s, flows: s.flows.filter((f) => f.id !== id) }));
}

/* ── Actions ──────────────────────────────────────────────────────────── */

/**
 * What a connector is installed from: a server in the registry, a URL, or one
 * Crew builds in, signed in as `loginHint` when the person picked an account
 * its siblings already have ("Continue as"). Its account is for `workspaces`,
 * `null` every one; not asked yet while `undefined`.
 */
export type Source = (
  | { kind: "registry"; server: RegistryServer }
  | { kind: "url"; url: string; name: string | null }
  | { kind: "builtin"; builtin: BuiltinConnector; loginHint?: string | null | undefined }
) & { workspaces?: string[] | null | undefined };

/** The connector a source is, once installed. */
const installedFrom = (s: State, source: Source) =>
  s.connectors.find((c) =>
    source.kind === "registry"
      ? c.registryName === source.server.name
      : source.kind === "builtin"
        ? c.builtin === source.builtin.id
        : c.registryName === null && c.builtin === null && c.url === source.url,
  );

/** Servers known to turn Crew's sign-in away: said before anyone tries, with where the vendor says so. */
const KNOWN_REFUSALS: Record<string, { why: string; docs: string }> = {};

/** Why a registry server could not be signed in to from Crew: known up front, or learned from a try this run. */
const refusals = new Map<string, string>(Object.entries(KNOWN_REFUSALS).map(([name, { why }]) => [name, why]));
export const refusalOf = (registryName: string | null | undefined) => (registryName ? refusals.get(registryName) : undefined);
/** Where the vendor explains a known refusal. */
export const refusalDocsOf = (registryName: string | null | undefined) => (registryName ? KNOWN_REFUSALS[registryName]?.docs : undefined);

export const actions = {
  /** Installs a connector, or finds it already installed. */
  async install(source: Source): Promise<Connector> {
    const known = installedFrom(state, source);
    if (known) return known;
    const connector = await connectorAdd(
      source.kind === "registry"
        ? { registryName: source.server.name, server: source.server, builtin: null, url: null, name: null }
        : source.kind === "builtin"
          ? { registryName: null, builtin: source.builtin.id, url: null, name: null }
          : { registryName: null, builtin: null, url: source.url, name: source.name },
    );
    putConnector(connector);
    return connector;
  },

  /**
   * Installs and signs in to a connector from the connect sheet. A server
   * that refuses Crew's sign-in is taken back out, and its reason kept so the
   * sheet and the directory can say it.
   */
  async installAndConnect(source: Source): Promise<{ connectorId: string; flowId: number; installed: boolean }> {
    const before = !!installedFrom(state, source);
    const connector = await actions.install(source);
    const flowId = signIn(connector.id, null, source.kind === "builtin" ? (source.loginHint ?? null) : null, source.workspaces ?? null);
    if (!before) {
      const watch = () => {
        const flow = state.flows.find((f) => f.id === flowId);
        if (!flow || flow.stage === "done") return listeners.delete(watch);
        if (flow.stage !== "failed") return;
        listeners.delete(watch);
        const now = state.connectors.find((c) => c.id === connector.id);
        // Nothing signed in: don't leave an empty connector behind.
        if (now && !now.accounts.some((a) => a.state !== "pending")) {
          // Only a refusal the daemon kept on the connector; a failure that may pass leaves Install as it was.
          if (source.kind === "registry" && now.refused && flow.error) refusals.set(source.server.name, flow.error);
          void connectorRemove(connector.id).catch(() => {});
          set((s) => ({ ...s, connectors: s.connectors.filter((c) => c.id !== connector.id) }));
        }
      };
      listeners.add(watch);
    }
    return { connectorId: connector.id, flowId, installed: !before };
  },

  /** Another account of an installed connector, for `workspaces` (or every one); it opens where the signed-in one does not answer for it. */
  addAccount(connectorId: string, workspaces: string[] | null): number {
    return signIn(connectorId, null, null, workspaces);
  },

  /** Signs an account in again: expired, short of scope, or never finished. */
  reconnect(accountId: string): number | null {
    const account = accountOf(state, accountId);
    return account ? signIn(account.connectorId, accountId) : null;
  },

  /** Lists the account's tools again; for a server that could not be reached, tries it now. */
  async refresh(accountId: string) {
    try {
      putAccount(await accountRefresh(accountId));
    } catch (error) {
      toast(`Couldn’t reach the server: ${message(error)}`, "danger");
    }
  },

  /** Revokes the grant and deletes the account; a throw reaches the confirmation. */
  async removeAccount(accountId: string) {
    await accountRemove(accountId);
    set((s) => ({ ...s, connectors: s.connectors.map((c) => ({ ...c, accounts: c.accounts.filter((a) => a.id !== accountId) })) }));
  },

  async removeConnector(connectorId: string) {
    const name = state.connectors.find((c) => c.id === connectorId)?.name;
    await connectorRemove(connectorId);
    toast(name ? `${name} removed` : "Connector removed");
    set((s) => ({ ...s, connectors: s.connectors.filter((c) => c.id !== connectorId) }));
  },

  rename(accountId: string, label: string) {
    void optimistic(
      () => patchAccount(accountId, (a) => ({ ...a, label })),
      () => accountRename(accountId, label),
      "Couldn’t rename it",
    );
  },

  /** Which workspaces an account is for; `null` is every one. */
  setWorkspaces(accountId: string, workspaces: string[] | null) {
    void optimistic(
      () => patchAccount(accountId, (a) => ({ ...a, workspaces })),
      () => accountWorkspacesSet(accountId, workspaces),
      "Couldn’t change its workspaces",
    );
  },

  setTool(accountId: string, tool: string, on: boolean) {
    void optimistic(
      () =>
        patchAccount(accountId, (a) => ({
          ...a,
          toolsOff: on ? a.toolsOff.filter((x) => x !== tool) : [...a.toolsOff.filter((x) => x !== tool), tool],
        })),
      () => toolSet({ accountId, tool, on }),
      "Couldn’t switch the tool",
    );
  },
};

/* ── Reading the model ──────────────────────────────────────────────── */

/** The built-ins of a family (Google's apps) that are installed. */
const familyOf = (s: State, family: string) =>
  s.connectors.filter((c) => c.builtin !== null && s.builtins.find((b) => b.id === c.builtin)?.family === family);

/**
 * The accounts a built-in can sign in as without a new sign-in to the
 * service: the ones its siblings have, that it has not yet. First signed in, first.
 */
export function familyIdentities(s: State, builtin: BuiltinConnector): string[] {
  const own = new Set(
    s.connectors
      .find((c) => c.builtin === builtin.id)
      ?.accounts.flatMap((a) => (a.identity ? [a.identity.toLowerCase()] : [])) ?? [],
  );
  const seen = familyOf(s, builtin.family)
    .flatMap((c) => c.accounts)
    .filter((a) => a.state !== "pending" && a.identity)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((a) => a.identity!);
  return [...new Set(seen.map((i) => i.toLowerCase()))].filter((i) => !own.has(i)).map((i) => seen.find((x) => x.toLowerCase() === i)!);
}

/** The other built-ins of its family an account's identity is signed in for, by name. */
export function siblingsOf(s: State, account: Account): string[] {
  const connector = s.connectors.find((c) => c.id === account.connectorId);
  const builtin = s.builtins.find((b) => b.id === connector?.builtin);
  if (!builtin || !account.identity) return [];
  const identity = account.identity.toLowerCase();
  return familyOf(s, builtin.family)
    .filter((c) => c.id !== account.connectorId && c.accounts.some((a) => a.identity?.toLowerCase() === identity))
    .map((c) => c.name);
}

/** The built-in a connector is, when it is one. */
export const builtinOf = (s: State, connector: Connector | undefined) => s.builtins.find((b) => b.id === connector?.builtin);

export const connectorOf = (s: State, id: string | undefined) => s.connectors.find((c) => c.id === id);
export const accountOf = (s: State, id: string | undefined) => s.connectors.flatMap((c) => c.accounts).find((a) => a.id === id);
/** A sign-in's account: its flow's, or, once the flow is let go, the one it landed on. */
export const accountOfFlow = (s: State, flowId: number | undefined) =>
  accountOf(s, s.flows.find((f) => f.id === flowId)?.accountId ?? (flowId === undefined ? undefined : landed.get(flowId)));

/** A sign-in of this window still running on the account. */
export const signingIn = (s: State, accountId: string) =>
  s.flows.some((f) => f.accountId === accountId && f.stage !== "done" && f.stage !== "failed");

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
