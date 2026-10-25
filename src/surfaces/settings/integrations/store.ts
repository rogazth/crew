// The Connectors page's model: Crew's connectors and their accounts as this
// Mac's vault keeps them (`connectors_list`, then every `connectors` event),
// the workspaces and bots an account can be turned on for, and the sign-ins
// this window has running. Every action is a daemon call; the few that a
// switch makes are shown at once and put back if the daemon refuses.
// See docs/plans/2026-10-23-integrations.md.
import { useSyncExternalStore } from "react";
import {
  accountRefresh,
  accountRemove,
  accountRename,
  bindingSet,
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
import type { BindingScope, Connector, ConnectorAccount, RegistryServer, SignIn } from "../../../lib/protocol";
import { toast } from "../ui";

export type Account = ConnectorAccount;
export type AccountState = Account["state"];
export type Scope = BindingScope;

/** Who an account can be turned on for: a workspace, or a bot in one. */
export type Consumer = { kind: "workspace" | "bot"; id: string; name: string; workspace?: string | undefined };

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
  consumers: Consumer[];
  flows: Flow[];
};

let state: State = { loaded: false, error: null, connectors: [], consumers: [], flows: [] };
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
  void load();
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

export function getState(): State {
  return state;
}

/** The app's workspaces and bots, as the page last saw them. */
export function setConsumers(consumers: Consumer[]) {
  if (JSON.stringify(consumers) === JSON.stringify(state.consumers)) return;
  set((s) => ({ ...s, consumers }));
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
function signIn(connectorId: string, accountId: string | null, label?: string): number {
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
      started = await connectorConnect({ connectorId, accountId, label: label ?? null });
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

/** What a connector is installed from: a server in the registry, or a URL. */
export type Source = { kind: "registry"; server: RegistryServer } | { kind: "url"; url: string; name: string | null };

/** Servers known to turn Crew's sign-in away: said before anyone tries, with where the vendor says so. */
const KNOWN_REFUSALS: Record<string, { why: string; docs: string }> = {
  "com.figma.mcp/mcp": {
    why: "Figma only allows approved MCP clients.",
    docs: "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server",
  },
};

/** Why a registry server could not be signed in to from Crew: known up front, or learned from a try this run. */
const refusals = new Map<string, string>(Object.entries(KNOWN_REFUSALS).map(([name, { why }]) => [name, why]));
export const refusalOf = (registryName: string | null | undefined) => (registryName ? refusals.get(registryName) : undefined);
/** Where the vendor explains a known refusal. */
export const refusalDocsOf = (registryName: string | null | undefined) => (registryName ? KNOWN_REFUSALS[registryName]?.docs : undefined);

export const actions = {
  /** Installs a connector, or finds it already installed. */
  async install(source: Source): Promise<Connector> {
    const known = state.connectors.find((c) =>
      source.kind === "registry" ? c.registryName === source.server.name : c.registryName === null && c.url === source.url,
    );
    if (known) return known;
    const connector = await connectorAdd(
      source.kind === "registry"
        ? { registryName: source.server.name, url: null, name: null }
        : { registryName: null, url: source.url, name: source.name },
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
    const before = state.connectors.some((c) => (source.kind === "registry" ? c.registryName === source.server.name : c.url === source.url));
    const connector = await actions.install(source);
    const flowId = signIn(connector.id, null);
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

  /** Another account of an installed connector; it opens where the signed-in one does not answer for it. */
  addAccount(connectorId: string): number {
    return signIn(connectorId, null);
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

  /** Turns an account on or off for a scope; `null` drops the scope's own binding. */
  bind(accountId: string, scope: Scope, on: boolean | null) {
    void optimistic(
      () =>
        patchAccount(accountId, (a) => {
          const rest = a.bindings.filter((b) => !sameScope(b.scope, scope));
          return { ...a, bindings: on === null ? rest : [...rest, { scope, on }] };
        }),
      () => bindingSet({ accountId, scope, on }),
      "Couldn’t change where it’s on",
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

export const connectorOf = (s: State, id: string | undefined) => s.connectors.find((c) => c.id === id);
export const accountOf = (s: State, id: string | undefined) => s.connectors.flatMap((c) => c.accounts).find((a) => a.id === id);
/** A sign-in's account: its flow's, or, once the flow is let go, the one it landed on. */
export const accountOfFlow = (s: State, flowId: number | undefined) =>
  accountOf(s, s.flows.find((f) => f.id === flowId)?.accountId ?? (flowId === undefined ? undefined : landed.get(flowId)));
export const consumerOf = (s: State, id: string) => s.consumers.find((c) => c.id === id);

export const sameScope = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind === "everywhere" || (b.kind !== "everywhere" && a.id === b.id));

/** A sign-in of this window still running on the account. */
export const signingIn = (s: State, accountId: string) =>
  s.flows.some((f) => f.accountId === accountId && f.stage !== "done" && f.stage !== "failed");

/** Whether an account is on for a consumer: its bot's binding, else its workspace's, else everywhere's; none is off. */
export function isOn(account: Account, consumer: Consumer | null): boolean {
  const find = (scope: Scope) => account.bindings.find((b) => sameScope(b.scope, scope));
  if (consumer?.kind === "bot") {
    const own = find({ kind: "bot", id: consumer.id });
    if (own) return own.on;
    if (consumer.workspace) {
      const workspace = find({ kind: "workspace", id: consumer.workspace });
      if (workspace) return workspace.on;
    }
  }
  if (consumer?.kind === "workspace") {
    const own = find({ kind: "workspace", id: consumer.id });
    if (own) return own.on;
  }
  return find({ kind: "everywhere" })?.on ?? false;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
