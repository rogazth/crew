// PROTOTYPE — throwaway. Fake data and simulated jobs for what the backend
// does not do yet: each CLI's version, account and install on every machine
// (keyed by environment, see envMock.ts), Crew's build and changelog. A module
// store, so the nav's badges and the page agree and a page switch keeps a
// running install going.
import { useSyncExternalStore } from "react";
import { defaultEffortOf, defaultModelOf, type Effort, type ProviderId } from "../../../lib/providers";
import { LOCAL_ENV, envById, providersEnvNow } from "./envMock";
import { toast } from "./ui";

export type InstallMethod = "npm" | "brew" | "script";

export type Job = {
  kind: "install" | "update" | "signin";
  progress: number;
  step: string;
  /** A remote signs in with a device code typed into the browser here. */
  code?: string;
};

/** Why the last install stopped, and what gets it going. */
export type Failure = { message: string; hint: string; fix: { label: string; command: string } | null };

export type ProviderMock = {
  id: ProviderId;
  name: string;
  vendor: string;
  blurb: string;
  binary: string;
  /** Where the binary is on PATH; null when it is not installed. */
  path: string | null;
  version: string | null;
  latest: string;
  account: { email: string; plan: string } | null;
  /** Where its sign-in happens. */
  signInAt: string;
  install: Partial<Record<InstallMethod, string>>;
  method: InstallMethod;
  job: Job | null;
  failure: Failure | null;
  model: string;
  effort: Effort | "";
};

export const METHOD_LABELS: Record<InstallMethod, string> = { npm: "npm", brew: "Homebrew", script: "Install script" };

const seed = (id: ProviderId) => ({ model: defaultModelOf(id), effort: defaultEffortOf(id, defaultModelOf(id)) });

const BASE: ProviderMock[] = [
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    blurb: "Fable, Opus, Sonnet and Haiku",
    binary: "claude",
    path: "~/.local/bin/claude",
    version: "2.1.3",
    latest: "2.1.4",
    account: { email: "gabriel@example.com", plan: "Max" },
    signInAt: "claude.ai",
    install: {
      npm: "npm install -g @anthropic-ai/claude-code",
      brew: "brew install --cask claude-code",
      script: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    method: "npm",
    job: null,
    failure: null,
    ...seed("claude"),
  },
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    blurb: "GPT-6 and GPT-5.6",
    binary: "codex",
    path: "/opt/homebrew/bin/codex",
    version: "0.48.0",
    latest: "0.48.0",
    account: { email: "gabriel@example.com", plan: "ChatGPT Pro" },
    signInAt: "chatgpt.com",
    install: { npm: "npm install -g @openai/codex", brew: "brew install codex" },
    method: "npm",
    job: null,
    failure: null,
    ...seed("codex"),
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "SST",
    blurb: "Open source, any model you have a key for",
    binary: "opencode",
    path: null,
    version: null,
    latest: "0.15.2",
    account: null,
    signInAt: "opencode.ai",
    install: {
      npm: "npm install -g opencode-ai",
      brew: "brew install sst/tap/opencode",
      script: "curl -fsSL https://opencode.ai/install | bash",
    },
    method: "npm",
    job: null,
    failure: null,
    ...seed("opencode"),
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    blurb: "Models from many vendors, one subscription",
    binary: "cursor-agent",
    path: "~/.local/bin/cursor-agent",
    version: "2026.10.09",
    latest: "2026.10.09",
    account: null,
    signInAt: "cursor.com",
    install: { script: "curl https://cursor.com/install -fsS | bash" },
    method: "script",
    job: null,
    failure: null,
    ...seed("cursor"),
  },
];

type Shape = Partial<Pick<ProviderMock, "version" | "path" | "account" | "method">>;

/** A Linux machine: no Homebrew, binaries under the user's home. */
function remote(shapes: Partial<Record<ProviderId, Shape>>, npm = true): ProviderMock[] {
  return BASE.map((p) => {
    const install = { ...p.install };
    delete install.brew;
    const shape = shapes[p.id];
    // Without Node there, the install script is the way in; npm stays offered (and fails, with a fix).
    const method = shape?.method ?? (install.npm && (npm || !install.script) ? "npm" : "script");
    if (!shape) return { ...p, install, method, version: null, path: null, account: null };
    return {
      ...p,
      install,
      method,
      version: shape.version ?? p.latest,
      path: shape.path ?? `~/.local/bin/${p.binary}`,
      account: shape.account === undefined ? { email: "gabriel@example.com", plan: p.account?.plan ?? "Pro" } : shape.account,
    };
  });
}

const INITIAL: Record<string, ProviderMock[]> = {
  [LOCAL_ENV]: BASE,
  // Claude only, and no Node there: npm installs fail until it has one.
  falcon: remote({ claude: { version: "2.1.4" }, cursor: { account: null } }, false),
  atlas: remote({ claude: { version: "2.1.3", path: "~/.npm-global/bin/claude" }, codex: { path: "~/.npm-global/bin/codex" } }),
  "gpu-box": remote({ claude: { version: "2.0.9" }, codex: {} }),
  "pi-lab": remote({ claude: { version: "1.9.2", account: null } }),
};

let byEnv: Record<string, ProviderMock[]> = INITIAL;
let checking = false;
const listeners = new Set<() => void>();
const timers = new Map<string, number>();
/** Machines that got Node through a fix: npm works there from then on. */
const nodeOn = new Set<string>();

const EMPTY: ProviderMock[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function listOf(env: string): ProviderMock[] {
  return byEnv[env] ?? EMPTY;
}

function find(id: ProviderId, env: string): ProviderMock {
  return listOf(env).find((x) => x.id === id)!;
}

function patch(id: ProviderId, change: Partial<ProviderMock> | ((p: ProviderMock) => Partial<ProviderMock>), env: string) {
  byEnv = {
    ...byEnv,
    [env]: listOf(env).map((p) => (p.id === id ? { ...p, ...(typeof change === "function" ? change(p) : change) } : p)),
  };
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The CLIs on one machine; this Mac's when no machine is named. */
export function useProviders(env: string = LOCAL_ENV): ProviderMock[] {
  return useSyncExternalStore(subscribe, () => listOf(env));
}

/** Every machine's CLIs, for the Environments cards. */
export function useAllProviders(): Record<string, ProviderMock[]> {
  return useSyncExternalStore(subscribe, () => byEnv);
}

export function useChecking(): boolean {
  return useSyncExternalStore(subscribe, () => checking);
}

/** A machine just added: what the setup found there, the rest to install. */
export function seedEnvProviders(env: string, found: string[]) {
  byEnv = {
    ...byEnv,
    [env]: remote(Object.fromEntries(BASE.filter((p) => found.includes(p.binary)).map((p) => [p.id, { account: null }]))),
  };
  emit();
}

export type Status = "installing" | "updating" | "not-installed" | "failed" | "signed-out" | "update" | "ok";

export function statusOf(p: ProviderMock): Status {
  if (p.job?.kind === "install") return "installing";
  if (p.job?.kind === "update") return "updating";
  if (!p.version) return p.failure ? "failed" : "not-installed";
  if (!p.account) return "signed-out";
  if (p.version !== p.latest) return "update";
  return "ok";
}

/** What the nav's Providers row counts: updates waiting and accounts signed out. */
export function attentionOf(list: ProviderMock[]): { count: number; wants: boolean } {
  const states = list.map(statusOf);
  return {
    count: states.filter((s) => s === "update" || s === "signed-out").length,
    wants: states.includes("signed-out"),
  };
}

const key = (id: ProviderId, env: string) => `${env}:${id}`;

/** Runs a fake job through its steps, ticking progress, then lands `done` (or `fails`). */
function run(
  id: ProviderId,
  env: string,
  kind: Job["kind"],
  steps: [number, string][],
  ms: number,
  done: Partial<ProviderMock>,
  message: string,
  fails?: { at: number; failure: Failure },
) {
  window.clearInterval(timers.get(key(id, env)));
  patch(id, { job: { kind, progress: 0, step: steps[0]![1] }, failure: null }, env);
  const started = performance.now();
  const timer = window.setInterval(() => {
    const progress = Math.min(1, (performance.now() - started) / ms);
    const step = [...steps].reverse().find(([at]) => progress >= at)?.[1] ?? steps[0]![1];
    if (fails && progress >= fails.at) {
      window.clearInterval(timer);
      patch(id, { job: null, failure: fails.failure }, env);
      toast(`${find(id, env).name} didn't install`, "danger");
    } else if (progress >= 1) {
      window.clearInterval(timer);
      patch(id, { ...done, job: null, failure: null }, env);
      toast(message);
    } else patch(id, { job: { kind, progress, step } }, env);
  }, 120);
  timers.set(key(id, env), timer);
}

export function installProvider(id: ProviderId, env: string = LOCAL_ENV) {
  const p = find(id, env);
  const machine = envById(env);
  const where = machine && machine.kind !== "local" ? ` on ${machine.name}` : "";
  const home = p.method === "brew" ? "/opt/homebrew/bin" : p.method === "npm" && where ? "~/.npm-global/bin" : "~/.local/bin";
  const noNode = p.method === "npm" && machine?.npm === false && !nodeOn.has(env);
  run(
    id,
    env,
    "install",
    [
      [0, where ? `Signing in to ${machine!.name}` : p.method === "brew" ? "Updating Homebrew" : "Resolving the package"],
      [0.12, "Resolving the package"],
      [0.22, `Downloading ${p.name} ${p.latest}`],
      [0.72, `Linking ${home}/${p.binary}`],
      [0.9, "Checking it runs"],
    ],
    where ? 5200 : 4200,
    { version: p.latest, path: `${home}/${p.binary}` },
    `${p.name} ${p.latest} is installed${where}`,
    noNode
      ? {
          at: 0.16,
          failure: {
            message: "bash: line 1: npm: command not found",
            hint: `${machine!.name} has no Node.js, which npm comes with. Crew can put Node 22 in your home folder there with fnm, then install ${p.name}. Nothing needs sudo.`,
            fix: {
              label: `Install Node.js and ${p.name}`,
              command: "curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22",
            },
          },
        }
      : undefined,
  );
}

/** The failure's fix: Node first, then the CLI, as one job. */
export function installWithNode(id: ProviderId, env: string) {
  const p = find(id, env);
  const machine = envById(env);
  nodeOn.add(env);
  run(
    id,
    env,
    "install",
    [
      [0, "Installing fnm"],
      [0.18, "Downloading Node.js 22.11.0"],
      [0.45, `Installing ${p.name} ${p.latest} with npm`],
      [0.85, `Linking ~/.npm-global/bin/${p.binary}`],
      [0.94, "Checking it runs"],
    ],
    7600,
    { version: p.latest, path: `~/.npm-global/bin/${p.binary}`, method: "npm" },
    `Node.js 22 and ${p.name} ${p.latest} are on ${machine?.name ?? "the machine"}`,
  );
}

export function updateProvider(id: ProviderId, env: string = LOCAL_ENV) {
  const p = find(id, env);
  run(
    id,
    env,
    "update",
    [
      [0, `Downloading ${p.latest}`],
      [0.75, `Replacing ${p.version}`],
    ],
    3000,
    { version: p.latest },
    `${p.name} is up to date`,
  );
}

export function signIn(id: ProviderId, env: string = LOCAL_ENV) {
  window.clearInterval(timers.get(key(id, env)));
  const remoteSignIn = env !== LOCAL_ENV;
  const code = remoteSignIn ? `${letters(4)}-${letters(4)}` : undefined;
  patch(id, { job: { kind: "signin", progress: 0, step: "Waiting for the browser", ...(code ? { code } : {}) } }, env);
  const timer = window.setTimeout(() => {
    const p = find(id, env);
    patch(id, { job: null, account: { email: "gabriel@example.com", plan: id === "cursor" ? "Pro" : "Free" } }, env);
    toast(`Signed in to ${p.name}${remoteSignIn ? ` on ${envById(env)?.name ?? env}` : ""}`);
  }, remoteSignIn ? 5200 : 3200);
  timers.set(key(id, env), timer);
}

function letters(n: number) {
  const pool = "BCDFGHJKLMNPQRSTVWXZ";
  return Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)]).join("");
}

export function cancelJob(id: ProviderId, env: string = LOCAL_ENV) {
  window.clearInterval(timers.get(key(id, env)));
  window.clearTimeout(timers.get(key(id, env)));
  patch(id, { job: null }, env);
}

export function dismissFailure(id: ProviderId, env: string = LOCAL_ENV) {
  patch(id, { failure: null }, env);
}

export function signOut(id: ProviderId, env: string = LOCAL_ENV) {
  patch(id, { account: null }, env);
}

export function uninstall(id: ProviderId, env: string = LOCAL_ENV) {
  patch(id, { version: null, path: null, account: null }, env);
}

export function setMethod(id: ProviderId, method: InstallMethod, env: string = LOCAL_ENV) {
  patch(id, { method, failure: null }, env);
}

export function setModel(id: ProviderId, model: string, effort: Effort | "", env: string = LOCAL_ENV) {
  patch(id, { model, effort }, env);
}

/** Asks every CLI's registry for its latest version, on the machine Providers shows. Here it only waits. */
export function checkAll(env?: string): Promise<number> {
  checking = true;
  emit();
  return new Promise((resolve) =>
    window.setTimeout(() => {
      checking = false;
      emit();
      resolve(listOf(env ?? providersEnvNow()).filter((p) => p.version && p.version !== p.latest).length);
    }, 1400),
  );
}

/** In the app, what `which` really found on this Mac wins over the fake data. */
export function syncInstalled(found: ProviderId[]) {
  byEnv = {
    ...byEnv,
    [LOCAL_ENV]: listOf(LOCAL_ENV).map((p) => {
      const on = found.includes(p.id);
      if (on === Boolean(p.version)) return p;
      return on
        ? { ...p, version: p.latest, path: `~/.local/bin/${p.binary}` }
        : { ...p, version: null, path: null, account: null };
    }),
  };
  emit();
}

/* ── Crew itself ────────────────────────────────────────────────────── */

export const BUILD: [string, string][] = [
  ["Version", "0.3.15 (arm64)"],
  ["Commit", "1b41045"],
  ["Built", "October 17, 2026"],
  ["Electron", "44.2.0"],
  ["Chromium", "150.0.7811.42"],
  ["Node", "24.11.0"],
  ["Daemon", "crewd 0.3.15"],
  ["macOS", "14.6 (23G80)"],
];

export type ChangeKind = "new" | "improved" | "fixed";

export const CHANGELOG: { version: string; date: string; notes: { kind: ChangeKind; text: string }[] }[] = [
  {
    version: "0.3.15",
    date: "October 17, 2026",
    notes: [
      { kind: "improved", text: "The composer shows its key hints only while a turn runs." },
      { kind: "fixed", text: "crewd keeps installing on a remote machine when lingering is refused, and warns it may stop at logout." },
    ],
  },
  {
    version: "0.3.14",
    date: "October 15, 2026",
    notes: [
      { kind: "new", text: "Agents on remote machines drive their workspace's tabs in Crew's browser." },
      { kind: "improved", text: "Pages see Google Chrome, so bot checks stop challenging Crew's browser." },
      { kind: "fixed", text: "After /clear, a relaunch follows claude to its new conversation." },
    ],
  },
  {
    version: "0.3.13",
    date: "October 13, 2026",
    notes: [
      { kind: "new", text: "Big attachments upload to remote machines in pieces, with progress." },
      { kind: "new", text: "Files picked in the dialog are sent to the remote machine too." },
      { kind: "improved", text: "A shell with no description is just called Shell, its command in the tooltip." },
      { kind: "fixed", text: "Tasks that ran in the foreground no longer leave a wake note." },
    ],
  },
  {
    version: "0.3.12",
    date: "October 9, 2026",
    notes: [
      { kind: "new", text: "File chips appear only when the file is really there." },
      { kind: "new", text: "@ mentions offer folders, which open in the explorer." },
      { kind: "improved", text: "A shell's header names it by a short label and shows its whole command." },
    ],
  },
  {
    version: "0.3.11",
    date: "October 6, 2026",
    notes: [{ kind: "new", text: "A steer shows as a bubble pinned at the foot of the transcript until the turn reads it." }],
  },
  {
    version: "0.3.10",
    date: "October 2, 2026",
    notes: [
      { kind: "new", text: "New sessions start on the last model, effort and access you picked." },
      { kind: "fixed", text: "Sessions get their titles again on every provider." },
      { kind: "fixed", text: "Fast mode is hidden where the account can't use it." },
    ],
  },
];
