// Replaced by streams S2–S4 of docs/plans/2026-10-19-design-system-finish.md
//
// Fake data and simulated jobs for what the backend does not do yet, behind
// the redesigned pages that are not reachable in the app until their stream
// lands (Providers, Environments, Add machine):
//   machines   this Mac and a few remotes in every connection state, the
//              ~/.ssh/config hosts and tailnet devices the add flow offers, and
//              the simulated walk that sets a new machine up
//   providers  each CLI's version, account and install on every machine
// Module stores, so a page switch keeps a running simulated job going.
import { useSyncExternalStore } from "react";
import { defaultEffortOf, defaultModelOf, type Effort, type ProviderId } from "../../lib/providers";
import { toast, type Tone } from "./ui";

export const LOCAL_ENV = "local";

export type EnvState = "connected" | "connecting" | "offline" | "error";
export type EnvKind = "local" | "ssh" | "tailscale";

export type EnvMock = {
  id: string;
  name: string;
  kind: EnvKind;
  /** What ssh is given: a Host from ~/.ssh/config, or user@address. */
  ssh: string | null;
  /** The tailnet address crewd listens on. */
  address: string | null;
  port: number;
  hostname: string;
  os: string;
  arch: string;
  platform: "mac" | "linux";
  crewd: string;
  state: EnvState;
  latency: number | null;
  relay: boolean;
  lastSeen: string;
  /** Why it is down, in ssh's or crewd's own words. */
  error: string | null;
  workspaces: string[];
  agentsRunning: number;
  load: number;
  cpus: number;
  memory: string;
  /** No Node on PATH there: npm installs fail. */
  npm: boolean;
  busy: string | null;
};

export const CURRENT_CREWD = "0.3.15";

const INITIAL_ENVS: EnvMock[] = [
  {
    id: LOCAL_ENV,
    name: "This Mac",
    kind: "local",
    ssh: null,
    address: null,
    port: 7777,
    hostname: "gabriels-mbp.local",
    os: "macOS 14.6",
    arch: "arm64",
    platform: "mac",
    crewd: CURRENT_CREWD,
    state: "connected",
    latency: null,
    relay: false,
    lastSeen: "now",
    error: null,
    workspaces: ["crew", "spendo", "dotfiles"],
    agentsRunning: 3,
    load: 2.41,
    cpus: 12,
    memory: "36 GB",
    npm: true,
    busy: null,
  },
  {
    id: "falcon",
    name: "falcon",
    kind: "tailscale",
    ssh: "falcon",
    address: "100.101.12.4",
    port: 7777,
    hostname: "falcon",
    os: "Ubuntu 24.04.1 LTS",
    arch: "x86_64",
    platform: "linux",
    crewd: CURRENT_CREWD,
    state: "connected",
    latency: 18,
    relay: false,
    lastSeen: "now",
    error: null,
    workspaces: ["crew", "infra"],
    agentsRunning: 1,
    load: 0.62,
    cpus: 16,
    memory: "41 GB free of 64 GB",
    npm: false,
    busy: null,
  },
  {
    id: "atlas",
    name: "atlas",
    kind: "ssh",
    ssh: "atlas",
    address: "100.88.40.17",
    port: 7777,
    hostname: "atlas-hel1",
    os: "Debian 12",
    arch: "aarch64",
    platform: "linux",
    crewd: "0.3.13",
    state: "connected",
    latency: 142,
    relay: true,
    lastSeen: "now",
    error: null,
    workspaces: ["spendo-api"],
    agentsRunning: 0,
    load: 0.08,
    cpus: 4,
    memory: "5.2 GB free of 8 GB",
    npm: true,
    busy: null,
  },
  {
    id: "gpu-box",
    name: "gpu-box",
    kind: "ssh",
    ssh: "ubuntu@gpu-box.lab",
    address: "100.70.2.9",
    port: 7777,
    hostname: "gpu-box",
    os: "Ubuntu 22.04.4 LTS",
    arch: "x86_64",
    platform: "linux",
    crewd: CURRENT_CREWD,
    state: "offline",
    latency: null,
    relay: false,
    lastSeen: "3 hours ago",
    error: "ssh: connect to host 100.70.2.9 port 22: Operation timed out",
    workspaces: ["trainer"],
    agentsRunning: 0,
    load: 0,
    cpus: 32,
    memory: "128 GB",
    npm: true,
    busy: null,
  },
  {
    id: "pi-lab",
    name: "pi-lab",
    kind: "tailscale",
    ssh: "pi@pi-lab",
    address: "100.64.0.31",
    port: 7777,
    hostname: "pi-lab",
    os: "Raspberry Pi OS 12",
    arch: "aarch64",
    platform: "linux",
    crewd: "0.2.9",
    state: "error",
    latency: 31,
    relay: false,
    lastSeen: "now",
    error: "Protocol 3; needs 5.",
    workspaces: [],
    agentsRunning: 0,
    load: 0.3,
    cpus: 4,
    memory: "2.1 GB free of 4 GB",
    npm: true,
    busy: null,
  },
];

let envs = INITIAL_ENVS;
let viewing = LOCAL_ENV;
const envListeners = new Set<() => void>();
const emitEnvs = () => envListeners.forEach((listener) => listener());
const subscribeEnvs = (listener: () => void) => {
  envListeners.add(listener);
  return () => envListeners.delete(listener);
};

export function useEnvs(): EnvMock[] {
  return useSyncExternalStore(subscribeEnvs, () => envs);
}

export function envById(id: string): EnvMock | undefined {
  return envs.find((env) => env.id === id);
}

/** The machine the Providers page shows. */
export function useProvidersEnv(): string {
  return useSyncExternalStore(subscribeEnvs, () => viewing);
}

export function providersEnvNow(): string {
  return viewing;
}

export function setProvidersEnv(id: string) {
  viewing = id;
  emitEnvs();
}

function patchEnv(id: string, change: Partial<EnvMock>) {
  envs = envs.map((env) => (env.id === id ? { ...env, ...change } : env));
  emitEnvs();
}

/** How a state reads where a chip says it. */
export function stateLabel(env: EnvMock): string {
  if (env.busy) return env.busy;
  switch (env.state) {
    case "connected":
      return env.kind === "local" ? "Running" : env.relay ? "Relayed" : "Connected";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
    case "error":
      return "Needs update";
  }
}

export function reconnectEnv(id: string) {
  const env = envById(id);
  if (!env) return;
  patchEnv(id, { state: "connecting", error: null });
  window.setTimeout(() => {
    // gpu-box is powered off: it stays down, with ssh's reason.
    if (id === "gpu-box") {
      patchEnv(id, { state: "offline", error: "ssh: connect to host 100.70.2.9 port 22: Operation timed out" });
      toast("Can't reach gpu-box", "danger");
      return;
    }
    if (env.crewd !== CURRENT_CREWD && id === "pi-lab") {
      patchEnv(id, { state: "error", error: "Protocol 3; needs 5." });
      return;
    }
    patchEnv(id, { state: "connected", latency: env.latency ?? 24, lastSeen: "now" });
    toast(`Connected to ${env.name}`);
  }, 1600);
}

export function updateCrewd(id: string) {
  const env = envById(id);
  if (!env) return;
  const steps = ["Uploading", "Restarting", "Pairing"];
  steps.forEach((step, index) => window.setTimeout(() => patchEnv(id, { busy: step }), index * 900));
  window.setTimeout(() => {
    patchEnv(id, { busy: null, crewd: CURRENT_CREWD, state: "connected", error: null, lastSeen: "now", latency: env.latency ?? 24 });
    toast(`${env.name} updated`);
  }, steps.length * 900);
}

/* ── Adding a machine ───────────────────────────────────────────────── */

export type SshConfigHost = { alias: string; hostname: string; user: string; port: number };
export type TailnetDevice = { host: string; ip: string; os: string; online: boolean; relay: boolean };

/** `ssh -G` over the user's ~/.ssh/config. `staging` has no key the server takes. */
export const SSH_CONFIG: SshConfigHost[] = [
  { alias: "falcon", hostname: "100.101.12.4", user: "gabriel", port: 22 },
  { alias: "atlas", hostname: "atlas.example.dev", user: "gabriel", port: 22 },
  { alias: "staging", hostname: "staging.example.com", user: "deploy", port: 22 },
  { alias: "hetzner-ci", hostname: "49.12.88.140", user: "root", port: 2222 },
];

export const TAILNET = {
  account: "gabriel@github",
  devices: [
    { host: "falcon", ip: "100.101.12.4", os: "linux", online: true, relay: false },
    { host: "orion", ip: "100.96.7.22", os: "linux", online: true, relay: false },
    { host: "studio-mini", ip: "100.79.3.50", os: "macOS", online: true, relay: true },
    { host: "nas", ip: "100.71.9.3", os: "linux", online: false, relay: false },
    { host: "gabriels-iphone", ip: "100.80.1.8", os: "iOS", online: true, relay: false },
  ] satisfies TailnetDevice[],
};

export type SetupStepId = "resolve" | "connect" | "probe" | "install" | "start" | "pair" | "clis";
export type StepState = "todo" | "running" | "done" | "error" | "skipped";
export type SetupStep = { id: SetupStepId; label: string; state: StepState; detail: string | null; progress: number | null };

export const SETUP_STEPS: { id: SetupStepId; label: string }[] = [
  { id: "resolve", label: "Resolve address" },
  { id: "connect", label: "Connect over SSH" },
  { id: "probe", label: "Check for crewd" },
  { id: "install", label: "Install crewd" },
  { id: "start", label: "Start service" },
  { id: "pair", label: "Pair over Tailscale" },
  { id: "clis", label: "Detect agents" },
];

export type SetupFailure = { step: SetupStepId; message: string; hint: string; fix: string | null };

export type SetupTarget = { ssh: string; user: string; port: number; host: string };

/** What the walk found once it lands. */
export type SetupResult = { os: string; arch: string; clis: string[] };

const attempts = new Map<string, number>();

/**
 * Walks a fake setup step by step, reporting each, and resolves with what it
 * found. `staging` fails on its first try with a key ssh refuses; a typo'd
 * address never resolves.
 */
export function runSetup(target: SetupTarget, onStep: (steps: SetupStep[]) => void): { done: Promise<SetupResult>; cancel: () => void } {
  let steps: SetupStep[] = SETUP_STEPS.map((s) => ({ ...s, state: "todo", detail: null, progress: null }));
  const timers: number[] = [];
  let cancelled = false;
  const set = (id: SetupStepId, change: Partial<SetupStep>) => {
    steps = steps.map((s) => (s.id === id ? { ...s, ...change } : s));
    onStep(steps);
  };
  const tries = (attempts.get(target.ssh) ?? 0) + 1;
  attempts.set(target.ssh, tries);
  const unresolvable = /\.(local|lan)$/.test(target.host) || target.host.includes("..") || target.host.endsWith(".");
  const refused = target.ssh === "staging" && tries === 1;
  const hasCrewd = target.ssh === "hetzner-ci";

  const done = new Promise<SetupResult>((resolve, reject) => {
    const at = (ms: number, work: () => void) => timers.push(window.setTimeout(() => !cancelled && work(), ms));
    const fail = (failure: SetupFailure) => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      set(failure.step, { state: "error", detail: failure.message });
      steps = steps.map((s) => (s.state === "todo" ? { ...s, state: "skipped" } : s));
      onStep(steps);
      reject(failure);
    };
    set("resolve", { state: "running" });
    at(700, () => {
      if (unresolvable)
        return fail({
          step: "resolve",
          message: `ssh: Could not resolve hostname ${target.host}: nodename nor servname provided`,
          hint: "Check the name or use its tailnet IP.",
          fix: null,
        });
      set("resolve", { state: "done", detail: target.host.match(/^\d/) ? target.host : `${target.host} → 100.92.14.6` });
      set("connect", { state: "running", detail: `ssh ${target.user ? `${target.user}@` : ""}${target.ssh}${target.port !== 22 ? ` -p ${target.port}` : ""}` });
    });
    at(1900, () => {
      if (refused)
        return fail({
          step: "connect",
          message: `${target.user || "deploy"}@${target.host}: Permission denied (publickey).`,
          hint: "Add your key, then retry:",
          fix: `ssh-copy-id ${target.user || "deploy"}@${target.host}`,
        });
      set("connect", { state: "done", detail: "Signed in with ~/.ssh/id_ed25519" });
      set("probe", { state: "running" });
    });
    at(2700, () => {
      set("probe", { state: "done", detail: hasCrewd ? `crewd 0.3.14 at ~/.crew/bin/crewd` : "Not installed · Ubuntu 24.04 x86_64" });
      set("install", { state: "running", progress: 0, detail: hasCrewd ? "Updating to 0.3.15" : "Uploading crewd 0.3.15 (18.1 MB)" });
    });
    const installMs = hasCrewd ? 1200 : 3000;
    for (let i = 1; i <= 20; i += 1)
      at(2700 + (installMs * i) / 20, () => {
        const progress = i / 20;
        set("install", {
          progress,
          detail: progress < 1 ? `Uploading crewd 0.3.15 · ${(18.1 * progress).toFixed(1)} of 18.1 MB` : "Installed at ~/.crew/bin/crewd",
        });
      });
    const t = 2700 + installMs;
    at(t + 50, () => {
      set("install", { state: "done", progress: null });
      set("start", { state: "running", detail: "systemctl --user enable --now crewd" });
    });
    at(t + 1000, () => {
      set("start", { state: "done", detail: "Listening on 7777" });
      set("pair", { state: "running" });
    });
    at(t + 1900, () => {
      set("pair", { state: "done", detail: "Paired, direct · 22 ms" });
      set("clis", { state: "running" });
    });
    at(t + 2600, () => {
      const clis = target.ssh === "orion" ? ["claude", "codex"] : ["claude"];
      set("clis", { state: "done", detail: `Found ${clis.join(", ")}` });
      resolve({ os: "Ubuntu 24.04.1 LTS", arch: "x86_64", clis });
    });
  });
  return {
    done,
    cancel: () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    },
  };
}

/** The machine lands in the list, connected. */
export function addEnv(input: { name: string; ssh: string; host: string; kind: EnvKind; result: SetupResult }): EnvMock {
  const id = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36).slice(-4)}`;
  const env: EnvMock = {
    id,
    name: input.name,
    kind: input.kind,
    ssh: input.ssh,
    address: "100.92.14.6",
    port: 7777,
    hostname: input.host,
    os: input.result.os,
    arch: input.result.arch,
    platform: "linux",
    crewd: CURRENT_CREWD,
    state: "connected",
    latency: 22,
    relay: false,
    lastSeen: "now",
    error: null,
    workspaces: [],
    agentsRunning: 0,
    load: 0.02,
    cpus: 8,
    memory: "14 GB free of 16 GB",
    npm: true,
    busy: null,
  };
  envs = [...envs, env];
  emitEnvs();
  return env;
}

/* ── How a machine reads ────────────────────────────────────────────── */

export const STATE_TONE: Record<EnvState, Tone> = {
  connected: "success",
  connecting: "warning",
  offline: "neutral",
  error: "danger",
};

export function toneOf(env: EnvMock): Tone {
  if (env.busy) return "accent";
  if (env.state === "connected" && env.relay) return "warning";
  return STATE_TONE[env.state];
}

/** Its own words for "here": this Mac, or the machine's name. */
export function hereOf(env: EnvMock): string {
  return env.kind === "local" ? "this Mac" : env.name;
}

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
