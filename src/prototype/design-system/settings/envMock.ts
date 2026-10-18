// PROTOTYPE — throwaway. Fake machines for the redesigned Environments page:
// this Mac and a few remotes in every connection state, the ~/.ssh/config
// hosts and tailnet devices the add flow offers, and the simulated walk that
// sets a new machine up (with the ways it really fails). Also the machine the
// Providers page is showing, so "Manage providers" can land on it.
import { useSyncExternalStore } from "react";
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

const INITIAL: EnvMock[] = [
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

let envs = INITIAL;
let viewing = LOCAL_ENV;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useEnvs(): EnvMock[] {
  return useSyncExternalStore(subscribe, () => envs);
}

export function envById(id: string): EnvMock | undefined {
  return envs.find((env) => env.id === id);
}

/** The machine the Providers page shows. */
export function useProvidersEnv(): string {
  return useSyncExternalStore(subscribe, () => viewing);
}

export function providersEnvNow(): string {
  return viewing;
}

export function setProvidersEnv(id: string) {
  viewing = id;
  emit();
}

function patch(id: string, change: Partial<EnvMock>) {
  envs = envs.map((env) => (env.id === id ? { ...env, ...change } : env));
  emit();
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
  patch(id, { state: "connecting", error: null });
  window.setTimeout(() => {
    // gpu-box is powered off: it stays down, with ssh's reason.
    if (id === "gpu-box") {
      patch(id, { state: "offline", error: "ssh: connect to host 100.70.2.9 port 22: Operation timed out" });
      toast("Can't reach gpu-box", "danger");
      return;
    }
    if (env.crewd !== CURRENT_CREWD && id === "pi-lab") {
      patch(id, { state: "error", error: "Protocol 3; needs 5." });
      return;
    }
    patch(id, { state: "connected", latency: env.latency ?? 24, lastSeen: "now" });
    toast(`Connected to ${env.name}`);
  }, 1600);
}

export function updateCrewd(id: string) {
  const env = envById(id);
  if (!env) return;
  const steps = ["Uploading", "Restarting", "Pairing"];
  steps.forEach((step, index) => window.setTimeout(() => patch(id, { busy: step }), index * 900));
  window.setTimeout(() => {
    patch(id, { busy: null, crewd: CURRENT_CREWD, state: "connected", error: null, lastSeen: "now", latency: env.latency ?? 24 });
    toast(`${env.name} updated`);
  }, steps.length * 900);
}

export function restartDaemon(id: string) {
  const env = envById(id);
  if (!env) return;
  patch(id, { busy: "Restarting" });
  window.setTimeout(() => {
    patch(id, { busy: null });
    toast("crewd restarted");
  }, 1400);
}

export function renameEnv(id: string, name: string) {
  patch(id, { name });
}

export function removeEnv(id: string) {
  envs = envs.filter((env) => env.id !== id);
  if (viewing === id) viewing = LOCAL_ENV;
  emit();
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
  emit();
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

/** Where a machine is, the way ssh would be told. */
export function whereOf(env: EnvMock): string {
  return env.kind === "local" ? env.hostname : (env.ssh ?? env.address ?? env.name);
}

/** Its own words for "here": this Mac, or the machine's name. */
export function hereOf(env: EnvMock): string {
  return env.kind === "local" ? "this Mac" : env.name;
}
