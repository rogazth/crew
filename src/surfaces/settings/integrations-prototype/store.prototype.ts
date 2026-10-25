// PROTOTYPE — throwaway. The in-memory model every Integrations variant reads:
// services from the registry, Crew's accounts in the vault, each CLI's own
// servers per machine, and stubbed actions that play out on timers (a sign-in
// opens a "tab", waits, then lands). Nothing reaches the daemon.
// See docs/plans/2026-10-23-integrations.md for the model this mirrors.
import { useSyncExternalStore } from "react";

export type MachineId = "local" | "devbox" | "gpu";
export type Machine = { id: MachineId; name: string; remote: boolean; online: boolean };

export type ProviderId = "claude" | "codex" | "cursor" | "opencode" | "grok";
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok Build",
};
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "cursor", "opencode", "grok"];
/** Cursor and Grok have no per-spawn way to leave a server out: their switch writes the CLI's config. */
export const PER_SPAWN: Record<ProviderId, boolean> = { claude: true, codex: true, opencode: true, cursor: false, grok: false };

export type Category = "Productivity" | "Developer" | "Data" | "Design" | "Ops";
export type Tool = { name: string; readOnly?: boolean; destructive?: boolean; tokens: number };

export type Service = {
  id: string;
  name: string;
  /** Reverse-DNS name in the registry: the publisher is its domain. */
  registry: string;
  publisher: string;
  host: string;
  /** The registry's own icon, when it lists one; otherwise the mark falls back to the publisher's favicon, then this monogram. */
  logo?: string | undefined;
  /** Monogram and hue for when there is no logo. */
  glyph: string;
  hue: number;
  category: Category;
  blurb: string;
  transport: "remote" | "stdio";
  /** Refuses Crew's OAuth client (Figma): it can only be used through a CLI's own sign-in. */
  refusesCrew?: boolean;
  tools: Tool[];
  /** How many people use it, for the browse ordering. */
  popular?: number;
};

export type AccountState = "connected" | "expired" | "needs-scope" | "lease-ending" | "vault-offline";
export type Scope = { kind: "everywhere" } | { kind: "workspace"; id: string } | { kind: "bot"; id: string };
export type Binding = { scope: Scope; on: boolean };
export type Account = {
  id: string;
  serviceId: string;
  label: string;
  identity: string;
  state: AccountState;
  bindings: Binding[];
  toolsOff: string[];
  connectedAt: string;
};

export type ServerState = "connected" | "needs-auth" | "failed" | "pending";
export type ProviderServer = {
  id: string;
  machine: MachineId;
  provider: ProviderId;
  name: string;
  /** The registry service it is, when Crew can tell (same host). */
  serviceId?: string | undefined;
  transport: "http" | "stdio" | "claude.ai";
  scope: "user" | "project" | "plugin" | "claude.ai";
  state: ServerState;
  offInCrew: boolean;
  tools: number;
  tokens: number;
  error?: string | undefined;
};

export type Vault = {
  machine: MachineId;
  state: "online" | "offline" | "moving";
  offlineSince?: string | undefined;
  /** Machines leasing from it, and how long their current lease lasts. */
  lessees: { machine: MachineId; leaseMinutes: number }[];
};

export type Consumer = { kind: "workspace" | "bot"; id: string; name: string; workspace?: string | undefined };

/** A sign-in being played out: a tab opens, the person consents, the code lands. */
export type FlowStage = "opening" | "waiting" | "redeeming" | "done" | "failed";
export type Flow = {
  id: number;
  kind: "account" | "server" | "vault-move";
  /** Account id, server id, or the machine the vault moves to. */
  target: string;
  serviceId?: string | undefined;
  machine: MachineId;
  stage: FlowStage;
  /** "Add another account" opens incognito, so the signed-in one does not answer. */
  incognito?: boolean | undefined;
};

export type Scenario = "fresh" | "using" | "offline";
export const SCENARIOS: { key: Scenario; name: string }[] = [
  { key: "fresh", name: "First open" },
  { key: "using", name: "In use" },
  { key: "offline", name: "Vault offline" },
];

export type State = {
  scenario: Scenario;
  machines: Machine[];
  vault: Vault;
  services: Service[];
  accounts: Account[];
  servers: ProviderServer[];
  consumers: Consumer[];
  flows: Flow[];
  /** Ids of the rows that just changed, so a variant can flash them once. */
  fresh: string[];
};

/* ── Fixtures ───────────────────────────────────────────────────────── */

const t = (name: string, tokens: number, extra: Partial<Tool> = {}): Tool => ({ name, tokens, ...extra });

export const SERVICES: Service[] = [
  {
    id: "notion", name: "Notion", registry: "com.notion/mcp", publisher: "notion.com", host: "mcp.notion.com", glyph: "N", hue: 0,
    category: "Productivity", blurb: "Search, read and edit pages and databases.", transport: "remote", popular: 98,
    tools: [t("notion-search", 420, { readOnly: true }), t("notion-fetch", 380, { readOnly: true }), t("notion-create-pages", 910), t("notion-update-page", 760), t("notion-move-pages", 300), t("notion-delete-pages", 260, { destructive: true }), t("notion-create-comment", 240), t("notion-get-users", 180, { readOnly: true })],
  },
  {
    id: "linear", name: "Linear", registry: "app.linear/linear", publisher: "linear.app", host: "mcp.linear.app", glyph: "L", hue: 268,
    category: "Productivity", blurb: "Issues, projects and cycles.", transport: "remote", popular: 91,
    tools: [t("list_issues", 520, { readOnly: true }), t("get_issue", 260, { readOnly: true }), t("create_issue", 640), t("update_issue", 610), t("create_comment", 220), t("list_projects", 300, { readOnly: true }), t("list_cycles", 210, { readOnly: true })],
  },
  {
    id: "sentry", name: "Sentry", registry: "io.github.getsentry/sentry-mcp", publisher: "sentry.io", host: "mcp.sentry.dev", glyph: "S", hue: 300,
    category: "Ops", blurb: "Errors, traces and Seer's root causes.", transport: "remote", popular: 77,
    tools: [t("search_issues", 640, { readOnly: true }), t("search_errors", 560, { readOnly: true }), t("get_sentry_resource", 300, { readOnly: true }), t("analyze_issue_with_seer", 420), t("update_issue", 380)],
  },
  {
    id: "atlassian", name: "Atlassian", registry: "com.atlassian/atlassian-mcp-server", publisher: "atlassian.com", host: "mcp.atlassian.com", glyph: "A", hue: 250,
    category: "Productivity", blurb: "Jira issues and Confluence pages.", transport: "remote", popular: 84,
    tools: [t("searchJiraIssuesUsingJql", 700, { readOnly: true }), t("getJiraIssue", 340, { readOnly: true }), t("createJiraIssue", 820), t("editJiraIssue", 760), t("transitionJiraIssue", 420), t("searchConfluence", 520, { readOnly: true }), t("createConfluenceContent", 880), t("executeDestructive", 300, { destructive: true })],
  },
  {
    id: "figma", name: "Figma", registry: "com.figma.mcp/mcp", publisher: "figma.com", host: "mcp.figma.com", glyph: "F", hue: 25,
    category: "Design", blurb: "Design context, screenshots and Code Connect.", transport: "remote", refusesCrew: true, popular: 88,
    tools: [t("get_design_context", 900, { readOnly: true }), t("get_screenshot", 300, { readOnly: true }), t("use_figma", 1200)],
  },
  {
    id: "github", name: "GitHub", registry: "io.github.github/github-mcp-server", publisher: "github.com", host: "api.githubcopilot.com", glyph: "GH", hue: -1,
    category: "Developer", blurb: "Repos, pull requests, issues and Actions.", transport: "remote", popular: 99,
    tools: [t("search_code", 500, { readOnly: true }), t("get_pull_request", 420, { readOnly: true }), t("create_pull_request", 700), t("merge_pull_request", 420, { destructive: true }), t("list_workflow_runs", 380, { readOnly: true })],
  },
  {
    id: "stripe", name: "Stripe", registry: "com.stripe/mcp", publisher: "stripe.com", host: "mcp.stripe.com", glyph: "S", hue: 275,
    category: "Data", blurb: "Customers, payments and subscriptions.", transport: "remote", popular: 70,
    tools: [t("list_customers", 400, { readOnly: true }), t("create_refund", 380, { destructive: true }), t("search_documentation", 300, { readOnly: true })],
  },
  {
    id: "supabase", name: "Supabase", registry: "com.supabase/mcp", publisher: "supabase.com", host: "mcp.supabase.com", glyph: "Sb", hue: 155,
    category: "Data", blurb: "Projects, SQL, migrations and logs.", transport: "remote", popular: 73,
    tools: [t("execute_sql", 400, { destructive: true }), t("list_tables", 300, { readOnly: true }), t("apply_migration", 420, { destructive: true }), t("get_logs", 260, { readOnly: true })],
  },
  {
    id: "vercel", name: "Vercel", registry: "com.vercel/vercel-mcp", publisher: "vercel.com", host: "mcp.vercel.com", glyph: "▲", hue: -1,
    category: "Ops", blurb: "Deployments, logs and domains.", transport: "remote", popular: 68,
    tools: [t("list_deployments", 320, { readOnly: true }), t("get_deployment_logs", 360, { readOnly: true })],
  },
  {
    id: "slack", name: "Slack", registry: "com.slack/mcp", publisher: "slack.com", host: "mcp.slack.com", glyph: "#", hue: 330,
    category: "Productivity", blurb: "Channels, threads and search.", transport: "remote", popular: 86,
    tools: [t("search_messages", 480, { readOnly: true }), t("post_message", 300), t("list_channels", 220, { readOnly: true })],
  },
  {
    id: "posthog", name: "PostHog", registry: "com.posthog/mcp", publisher: "posthog.com", host: "mcp.posthog.com", glyph: "PH", hue: 45,
    category: "Data", blurb: "Insights, flags and experiments.", transport: "remote", popular: 52,
    tools: [t("query_insights", 500, { readOnly: true }), t("update_feature_flag", 340)],
  },
  {
    id: "spendo", name: "Spendo", registry: "app.spendo/mcp", publisher: "spendo.app", host: "mcp.spendo.app", glyph: "$", hue: 160,
    category: "Data", blurb: "Accounts, budgets and transactions.", transport: "remote", popular: 12,
    tools: [t("get-transactions-tool", 420, { readOnly: true }), t("create-transaction-tool", 520), t("delete-transaction-tool", 260, { destructive: true })],
  },
  {
    id: "custom:deploys", name: "Acme Deploys", registry: "https://deploys.acme.internal/mcp", publisher: "Custom connector", host: "deploys.acme.internal", glyph: "A", hue: 28,
    category: "Ops", blurb: "", transport: "remote",
    tools: [t("list_deploys", 280, { readOnly: true }), t("rollback", 340, { destructive: true })],
  },
  {
    id: "context7", name: "Context7", registry: "com.upstash/context7", publisher: "upstash.com", host: "npx @upstash/context7-mcp", glyph: "C7", hue: 195,
    category: "Developer", blurb: "Current docs for any library.", transport: "stdio", popular: 90,
    tools: [t("resolve-library-id", 300, { readOnly: true }), t("query-docs", 420, { readOnly: true })],
  },
  {
    id: "chrome-devtools", name: "Chrome DevTools", registry: "com.google/chrome-devtools-mcp", publisher: "google.com", host: "npx chrome-devtools-mcp", glyph: "CD", hue: 225,
    category: "Developer", blurb: "Drive and inspect a Chrome.", transport: "stdio", popular: 80,
    tools: Array.from({ length: 26 }, (_, i) => t(`tool_${i}`, 260)),
  },
  {
    id: "playwright", name: "Playwright", registry: "com.microsoft/playwright-mcp", publisher: "microsoft.com", host: "npx @playwright/mcp", glyph: "Pw", hue: 140,
    category: "Developer", blurb: "Browser automation.", transport: "stdio", popular: 75,
    tools: Array.from({ length: 21 }, (_, i) => t(`browser_${i}`, 240)),
  },
  {
    id: "postgres", name: "Postgres", registry: "io.modelcontextprotocol/postgres", publisher: "modelcontextprotocol.io", host: "npx @modelcontextprotocol/server-postgres", glyph: "Pg", hue: 235,
    category: "Data", blurb: "Read-only SQL against a database.", transport: "stdio", popular: 60,
    tools: [t("query", 280, { readOnly: true })],
  },
];

const MACHINES: Machine[] = [
  { id: "local", name: "This Mac", remote: false, online: true },
  { id: "devbox", name: "devbox", remote: true, online: true },
  { id: "gpu", name: "gpu-box", remote: true, online: true },
];

const CONSUMERS: Consumer[] = [
  { kind: "workspace", id: "crew", name: "crew" },
  { kind: "workspace", id: "storefront-api", name: "storefront-api" },
  { kind: "workspace", id: "ledger", name: "ledger" },
  { kind: "bot", id: "planner", name: "Planner", workspace: "crew" },
  { kind: "bot", id: "reviewer", name: "Reviewer", workspace: "crew" },
  { kind: "bot", id: "bookkeeper", name: "Bookkeeper", workspace: "ledger" },
];

const everywhere = (on = true): Binding => ({ scope: { kind: "everywhere" }, on });
const ws = (id: string, on = true): Binding => ({ scope: { kind: "workspace", id }, on });
const bot = (id: string, on = true): Binding => ({ scope: { kind: "bot", id }, on });

function serversFor(scenario: Scenario): ProviderServer[] {
  const s = (
    id: string,
    machine: MachineId,
    provider: ProviderId,
    name: string,
    serviceId: string | undefined,
    transport: ProviderServer["transport"],
    scope: ProviderServer["scope"],
    state: ServerState,
    extra: Partial<ProviderServer> = {},
  ): ProviderServer => {
    const service = SERVICES.find((x) => x.id === serviceId);
    const tools = service?.tools.length ?? 4;
    const tokens = service?.tools.reduce((n, tool) => n + tool.tokens, 0) ?? 1200;
    return { id, machine, provider, name, serviceId, transport, scope, state, offInCrew: false, tools, tokens, ...extra };
  };
  const using = scenario !== "fresh";
  return [
    s("l-claude-context7", "local", "claude", "context7", "context7", "stdio", "user", "connected"),
    s("l-claude-devtools", "local", "claude", "chrome-devtools", "chrome-devtools", "stdio", "user", "connected"),
    s("l-claude-notion", "local", "claude", "claude.ai Notion", "notion", "claude.ai", "claude.ai", "connected", { offInCrew: using }),
    s("l-claude-figma", "local", "claude", "claude.ai Figma", "figma", "claude.ai", "claude.ai", "connected"),
    s("l-claude-atlassian", "local", "claude", "claude.ai Atlassian", "atlassian", "claude.ai", "claude.ai", "connected"),
    s("l-claude-sentry", "local", "claude", "claude.ai Sentry", "sentry", "claude.ai", "claude.ai", "needs-auth"),
    s("l-claude-spendo", "local", "claude", "claude.ai Spendo", "spendo", "claude.ai", "claude.ai", "connected"),
    s("l-codex-context7", "local", "codex", "context7", "context7", "stdio", "user", "connected"),
    s("l-codex-linear", "local", "codex", "linear", "linear", "http", "user", "needs-auth"),
    s("l-cursor-figma", "local", "cursor", "figma", "figma", "http", "user", "connected"),
    s("l-cursor-playwright", "local", "cursor", "playwright", "playwright", "stdio", "user", "failed", { error: "npx exited 1: EACCES ~/.npm/_cacache" }),
    s("l-opencode-context7", "local", "opencode", "context7", "context7", "stdio", "user", "connected"),
    s("d-claude-context7", "devbox", "claude", "context7", "context7", "stdio", "user", "connected"),
    s("d-claude-postgres", "devbox", "claude", "postgres", "postgres", "stdio", "project", "connected"),
    s("d-claude-figma", "devbox", "claude", "claude.ai Figma", "figma", "claude.ai", "claude.ai", "needs-auth"),
    s("d-codex-context7", "devbox", "codex", "context7", "context7", "stdio", "user", "connected"),
    s("g-claude-context7", "gpu", "claude", "context7", "context7", "stdio", "user", "pending"),
    s("g-grok-playwright", "gpu", "grok", "playwright", "playwright", "stdio", "user", "connected"),
  ];
}

function accountsFor(scenario: Scenario): Account[] {
  if (scenario === "fresh") return [];
  const offline = scenario === "offline";
  return [
    { id: "notion-work", serviceId: "notion", label: "Work", identity: "gabriel@acme.dev", state: offline ? "lease-ending" : "connected", bindings: [everywhere()], toolsOff: ["notion-delete-pages"], connectedAt: "Oct 18" },
    { id: "notion-personal", serviceId: "notion", label: "Personal", identity: "gabriel98rl@gmail.com", state: offline ? "vault-offline" : "expired", bindings: [everywhere(false), bot("bookkeeper")], toolsOff: [], connectedAt: "Oct 21" },
    { id: "linear-acme", serviceId: "linear", label: "Acme", identity: "gabriel@acme.dev", state: offline ? "lease-ending" : "connected", bindings: [ws("crew"), ws("storefront-api")], toolsOff: [], connectedAt: "Oct 19" },
    { id: "sentry-acme", serviceId: "sentry", label: "Acme", identity: "acme-org", state: "needs-scope", bindings: [ws("storefront-api")], toolsOff: [], connectedAt: "Oct 20" },
    { id: "atlassian-acme", serviceId: "atlassian", label: "Acme", identity: "acme.atlassian.net", state: offline ? "vault-offline" : "connected", bindings: [everywhere(), bot("reviewer", false)], toolsOff: ["executeDestructive", "createConfluenceContent"], connectedAt: "Oct 16" },
    // A custom connector: no registry logo and no favicon, so its mark is a monogram.
    { id: "deploys-acme", serviceId: "custom:deploys", label: "Acme", identity: "deploys.acme.internal", state: offline ? "vault-offline" : "connected", bindings: [ws("crew")], toolsOff: [], connectedAt: "Oct 23" },
    { id: "spendo-me", serviceId: "spendo", label: "Me", identity: "gabriel98rl@gmail.com", state: offline ? "vault-offline" : "connected", bindings: [ws("ledger")], toolsOff: [], connectedAt: "Oct 22" },
  ];
}

function vaultFor(scenario: Scenario): Vault {
  if (scenario === "fresh") return { machine: "local", state: "online", lessees: [] };
  if (scenario === "offline")
    return { machine: "devbox", state: "offline", offlineSince: "14:02", lessees: [{ machine: "local", leaseMinutes: 23 }, { machine: "gpu", leaseMinutes: 0 }] };
  return { machine: "devbox", state: "online", lessees: [{ machine: "local", leaseMinutes: 48 }, { machine: "gpu", leaseMinutes: 51 }] };
}

function initial(scenario: Scenario): State {
  return {
    scenario,
    machines: MACHINES.map((m) => (scenario === "offline" && m.id === "devbox" ? { ...m, online: false } : m)),
    vault: vaultFor(scenario),
    services: SERVICES,
    accounts: accountsFor(scenario),
    servers: serversFor(scenario),
    consumers: CONSUMERS,
    flows: [],
    fresh: [],
  };
}

/* ── Store ──────────────────────────────────────────────────────────── */

const SCENARIO_KEY = "prototype:integrations-scenario";

function storedScenario(): Scenario {
  const fromUrl = new URLSearchParams(location.search).get("scenario");
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SCENARIO_KEY);
  } catch {
    /* private mode */
  }
  const pick = fromUrl ?? stored;
  return SCENARIOS.some((s) => s.key === pick) ? (pick as Scenario) : "using";
}

let state: State = initial(storedScenario());
const listeners = new Set<() => void>();

function set(next: State | ((s: State) => State)) {
  state = typeof next === "function" ? next(state) : next;
  listeners.forEach((l) => l());
}

export function useIntegrations(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export function getState(): State {
  return state;
}

function flash(...ids: string[]) {
  set((s) => ({ ...s, fresh: [...s.fresh, ...ids] }));
  window.setTimeout(() => set((s) => ({ ...s, fresh: s.fresh.filter((id) => !ids.includes(id)) })), 1400);
}

let flowSeq = 0;
/** Plays a sign-in: the tab opens (0.5 s), waits on the person (1.6 s), the daemon redeems the code (0.7 s). */
function play(flow: Omit<Flow, "id" | "stage">, land: () => void, fail = false) {
  const id = ++flowSeq;
  const stage = (next: FlowStage) => set((s) => ({ ...s, flows: s.flows.map((f) => (f.id === id ? { ...f, stage: next } : f)) }));
  set((s) => ({ ...s, flows: [...s.flows, { ...flow, id, stage: "opening" }] }));
  window.setTimeout(() => stage("waiting"), 500);
  window.setTimeout(() => stage("redeeming"), 2100);
  window.setTimeout(() => {
    if (fail) {
      stage("failed");
    } else {
      land();
      stage("done");
    }
  }, 2800);
  window.setTimeout(() => set((s) => ({ ...s, flows: s.flows.filter((f) => f.id !== id) })), fail ? 6000 : 3600);
  return id;
}

export function dismissFlow(id: number) {
  set((s) => ({ ...s, flows: s.flows.filter((f) => f.id !== id) }));
}

export const actions = {
  setScenario(scenario: Scenario) {
    try {
      localStorage.setItem(SCENARIO_KEY, scenario);
    } catch {
      /* private mode */
    }
    const url = new URL(location.href);
    url.searchParams.set("scenario", scenario);
    history.replaceState(history.state, "", url);
    set(initial(scenario));
  },

  /** Connect a service from the catalog: a new account, signed in through the vault. */
  connect(serviceId: string, label?: string): string | null {
    const service = SERVICES.find((x) => x.id === serviceId);
    if (!service || service.refusesCrew) return null;
    const existing = state.accounts.filter((a) => a.serviceId === serviceId);
    const id = `${serviceId}-${Date.now().toString(36)}`;
    const name = label ?? (existing.length === 0 ? "Work" : `Account ${existing.length + 1}`);
    play({ kind: "account", target: id, serviceId, machine: state.vault.machine, incognito: existing.length > 0 }, () => {
      set((s) => ({
        ...s,
        accounts: [
          ...s.accounts,
          {
            id,
            serviceId,
            label: name,
            identity: existing.length === 0 ? "gabriel@acme.dev" : "gabriel98rl@gmail.com",
            state: "connected",
            // The first account of a service is on everywhere; another starts on nowhere.
            bindings: [everywhere(existing.length === 0)],
            toolsOff: service.tools.filter((tool) => tool.destructive).map((tool) => tool.name),
            connectedAt: "Just now",
          },
        ],
      }));
      flash(id);
    });
    return id;
  },

  /** A custom local server: nothing to sign in to, so its one account lands at once. */
  addLocal(serviceId: string): string {
    const id = `${serviceId}-${Date.now().toString(36)}`;
    set((s) => ({
      ...s,
      accounts: [
        ...s.accounts,
        { id, serviceId, label: "Local", identity: machineOf(s, s.vault.machine).name, state: "connected", bindings: [everywhere()], toolsOff: [], connectedAt: "Just now" },
      ],
    }));
    flash(id);
    return id;
  },

  /** Sign an expired or under-scoped account in again. */
  reconnect(accountId: string) {
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) return;
    play({ kind: "account", target: accountId, serviceId: account.serviceId, machine: state.vault.machine }, () => {
      set((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, state: "connected" } : a)) }));
      flash(accountId);
    });
  },

  disconnect(accountId: string) {
    set((s) => ({ ...s, accounts: s.accounts.filter((a) => a.id !== accountId) }));
  },

  rename(accountId: string, label: string) {
    set((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, label } : a)) }));
  },

  /** Turn an account on or off for a scope; the most specific binding wins. */
  bind(accountId: string, scope: Scope, on: boolean) {
    const same = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind === "everywhere" || (b.kind !== "everywhere" && a.id === b.id));
    set((s) => ({
      ...s,
      accounts: s.accounts.map((a) => {
        if (a.id !== accountId) return a;
        const rest = a.bindings.filter((b) => !same(b.scope, scope));
        return { ...a, bindings: [...rest, { scope, on }] };
      }),
    }));
    flash(accountId);
  },

  unbind(accountId: string, scope: Scope) {
    set((s) => ({
      ...s,
      accounts: s.accounts.map((a) =>
        a.id !== accountId
          ? a
          : { ...a, bindings: a.bindings.filter((b) => !(b.scope.kind === scope.kind && (scope.kind === "everywhere" || (b.scope.kind !== "everywhere" && b.scope.id === scope.id)))) },
      ),
    }));
  },

  toggleTool(accountId: string, tool: string) {
    set((s) => ({
      ...s,
      accounts: s.accounts.map((a) =>
        a.id !== accountId ? a : { ...a, toolsOff: a.toolsOff.includes(tool) ? a.toolsOff.filter((x) => x !== tool) : [...a.toolsOff, tool] },
      ),
    }));
  },

  /** A CLI's own server: its sign-in runs on the machine whose CLI uses it. */
  signInServer(serverId: string) {
    const server = state.servers.find((x) => x.id === serverId);
    if (!server) return;
    set((s) => ({ ...s, servers: s.servers.map((x) => (x.id === serverId ? { ...x, state: "pending" } : x)) }));
    play({ kind: "server", target: serverId, serviceId: server.serviceId, machine: server.machine }, () => {
      set((s) => ({ ...s, servers: s.servers.map((x) => (x.id === serverId ? { ...x, state: "connected", error: undefined } : x)) }));
      flash(serverId);
    });
  },

  /** The same service on every machine whose CLI has it and needs a sign-in, one after another. */
  signInEverywhere(serviceId: string, provider: ProviderId) {
    const waiting = state.servers.filter((x) => x.serviceId === serviceId && x.provider === provider && x.state === "needs-auth");
    waiting.forEach((server, i) => window.setTimeout(() => actions.signInServer(server.id), i * 900));
  },

  retryServer(serverId: string) {
    set((s) => ({ ...s, servers: s.servers.map((x) => (x.id === serverId ? { ...x, state: "pending" } : x)) }));
    window.setTimeout(() => {
      set((s) => ({ ...s, servers: s.servers.map((x) => (x.id === serverId ? { ...x, state: "connected", error: undefined } : x)) }));
      flash(serverId);
    }, 1200);
  },

  setOffInCrew(serverId: string, off: boolean) {
    set((s) => ({ ...s, servers: s.servers.map((x) => (x.id === serverId ? { ...x, offInCrew: off } : x)) }));
    flash(serverId);
  },

  /** Remove servers from their CLIs' configs. */
  uninstallServers(ids: string[]) {
    set((s) => ({ ...s, servers: s.servers.filter((x) => !ids.includes(x.id)) }));
  },

  /** Keep Crew's account of a service and leave the CLIs' copies out of Crew's sessions. */
  keepCrews(serviceId: string) {
    const ids = state.servers.filter((x) => x.serviceId === serviceId && !x.offInCrew).map((x) => x.id);
    set((s) => ({ ...s, servers: s.servers.map((x) => (ids.includes(x.id) ? { ...x, offInCrew: true } : x)) }));
    flash(...ids);
  },

  /** Make a Crew connector out of a CLI's server: sign in through the vault, then turn the CLI's off in Crew. */
  moveToCrew(serverId: string) {
    const server = state.servers.find((x) => x.id === serverId);
    if (!server?.serviceId) return;
    const id = actions.connect(server.serviceId);
    if (id) window.setTimeout(() => actions.keepCrews(server.serviceId!), 3000);
  },

  /** Move the vault: the new one pulls the grants, the old one deletes them. */
  moveVault(machine: MachineId) {
    if (machine === state.vault.machine) return;
    set((s) => ({ ...s, vault: { ...s.vault, state: "moving" } }));
    play({ kind: "vault-move", target: machine, machine }, () => {
      const lessees = state.machines.filter((m) => m.id !== machine).map((m) => ({ machine: m.id, leaseMinutes: 55 }));
      set((s) => ({ ...s, vault: { machine, state: "online", lessees }, accounts: s.accounts.map((a) => ({ ...a, state: a.state === "needs-scope" ? a.state : "connected" })) }));
      flash("vault");
    });
  },

  /** Bring an offline vault back (the machine came online). */
  vaultBack() {
    set((s) => ({
      ...s,
      machines: s.machines.map((m) => ({ ...m, online: true })),
      vault: { ...s.vault, state: "online", offlineSince: undefined, lessees: s.vault.lessees.map((l) => ({ ...l, leaseMinutes: 55 })) },
      accounts: s.accounts.map((a) => (a.state === "vault-offline" || a.state === "lease-ending" ? { ...a, state: "connected" } : a)),
    }));
    flash("vault");
  },
};

/* ── Reading the model ──────────────────────────────────────────────── */

export const serviceOf = (id: string | undefined) => SERVICES.find((x) => x.id === id);

/** A service found in the live registry joins the catalog the moment it is picked, so the connect flow can find it. */
export function registerService(service: Service): Service {
  const known = SERVICES.find((x) => x.id === service.id);
  if (known) return known;
  SERVICES.push(service);
  set((s) => ({ ...s }));
  return service;
}
export const machineOf = (state: State, id: MachineId) => state.machines.find((m) => m.id === id)!;
export const consumerOf = (state: State, id: string) => state.consumers.find((c) => c.id === id);

export function scopeName(s: State, scope: Scope): string {
  if (scope.kind === "everywhere") return "Everywhere";
  return consumerOf(s, scope.id)?.name ?? scope.id;
}

/** Whether an account is on for a consumer: its bot's binding, else its workspace's, else everywhere's. */
export function isOn(_state: State, account: Account, consumer: Consumer | null): boolean {
  const find = (scope: Scope) =>
    account.bindings.find((b) => b.scope.kind === scope.kind && (scope.kind === "everywhere" || (b.scope.kind !== "everywhere" && b.scope.id === scope.id)));
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

/** Tokens an account's tools put in context where it is on. */
export function accountTokens(account: Account): number {
  const service = serviceOf(account.serviceId);
  return service?.tools.filter((tool) => !account.toolsOff.includes(tool.name)).reduce((n, tool) => n + tool.tokens, 0) ?? 0;
}

/** What a consumer's sessions get from Crew's accounts and, on a machine, from one CLI's own servers. */
export function contextCost(s: State, consumer: Consumer | null, machine: MachineId, provider: ProviderId): number {
  const crew = s.accounts.filter((a) => isOn(s, a, consumer)).reduce((n, a) => n + accountTokens(a), 0);
  const own = s.servers.filter((x) => x.machine === machine && x.provider === provider && !x.offInCrew && x.state === "connected").reduce((n, x) => n + x.tokens, 0);
  return crew + own;
}

export type Duplicate = { service: Service; accounts: Account[]; servers: ProviderServer[] };

/** A service Crew has an account of that a CLI also loads in Crew's sessions. */
export function duplicates(s: State): Duplicate[] {
  const out: Duplicate[] = [];
  for (const service of SERVICES) {
    const accounts = s.accounts.filter((a) => a.serviceId === service.id);
    const servers = s.servers.filter((x) => x.serviceId === service.id && !x.offInCrew && x.transport !== "stdio");
    if (accounts.length > 0 && servers.length > 0) out.push({ service, accounts, servers });
  }
  return out;
}

export type Attention = {
  id: string;
  tone: "warning" | "danger" | "info";
  title: string;
  detail: string;
  action: string;
  run: () => void;
};

/** What wants the person, most urgent first. */
export function attention(s: State): Attention[] {
  const out: Attention[] = [];
  if (s.vault.state === "offline") {
    const vault = machineOf(s, s.vault.machine);
    out.push({
      id: "vault",
      tone: "danger",
      title: `The vault on ${vault.name} is offline`,
      detail: `Since ${s.vault.offlineSince}. This Mac's leases end in ${s.vault.lessees.find((l) => l.machine === "local")?.leaseMinutes ?? 0} min.`,
      action: "Bring it back",
      run: actions.vaultBack,
    });
  }
  for (const account of s.accounts) {
    const service = serviceOf(account.serviceId)!;
    if (account.state === "needs-scope")
      out.push({ id: account.id, tone: "warning", title: `${service.name} · ${account.label} needs more access`, detail: "A tool asked for a scope the sign-in did not grant.", action: "Authenticate", run: () => actions.reconnect(account.id) });
    if (account.state === "expired")
      out.push({ id: account.id, tone: "warning", title: `${service.name} · ${account.label} signed out`, detail: "The service revoked the grant.", action: "Authenticate", run: () => actions.reconnect(account.id) });
  }
  for (const server of s.servers.filter((x) => x.state === "needs-auth" && !x.offInCrew)) {
    out.push({
      id: server.id,
      tone: "info",
      title: `${server.name} needs a sign-in`,
      detail: `${PROVIDER_NAMES[server.provider]} on ${machineOf(s, server.machine).name}`,
      action: "Authenticate",
      run: () => actions.signInServer(server.id),
    });
  }
  for (const server of s.servers.filter((x) => x.state === "failed" && !x.offInCrew)) {
    out.push({ id: server.id, tone: "danger", title: `${server.name} failed to start`, detail: server.error ?? "", action: "Retry", run: () => actions.retryServer(server.id) });
  }
  return out;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
