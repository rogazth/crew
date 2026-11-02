// The window's view of the settings: read once, kept by `settings-changed`, and
// written through the daemon that holds them. A setting is defined beside what
// it means (`defineSetting`) and listed in `defs`; everything else is here.
import { useCallback, useSyncExternalStore } from "react";
import { client } from "../client";
import { getLinks, onConnected, subscribeLinks } from "../client/registry";
import type { SettingRow, SettingsChanged } from "../protocol";
import type { SettingDef } from "./define";
import { LOCAL_ENV, Reconciler, type MachineSync } from "./reconciler";

type EnvOption = { env?: string };

const rows = new Map<string, Map<string, SettingRow>>();
const parsed = new Map<string, { raw: string | null; value: unknown }>();
const watchers = new Map<string, Set<() => void>>();
const loads = new Map<string, Promise<void>>();
/** Keys with a write on its way: a list that was read before it must not put the old value back. */
const writing = new Set<string>();
const failureListeners = new Set<(key: string, error: unknown) => void>();
let bridged = false;
let globalKeys: string[] = [];

const reconciler = new Reconciler({
  keys: () => globalKeys,
  request: (method, params, env) => client.request(method, params, env),
  machines: () =>
    getLinks()
      .filter((link) => link.id !== LOCAL_ENV)
      .map((link) => ({ id: link.id, name: link.name, status: link.status, mismatch: link.mismatch })),
});

const slot = (home: string, key: string) => `${home}\u0000${key}`;

function notify(home: string, key: string) {
  for (const watcher of [...(watchers.get(slot(home, key)) ?? [])]) watcher();
}

function hold(home: string, row: SettingRow) {
  let held = rows.get(home);
  if (!held) {
    held = new Map();
    rows.set(home, held);
  }
  const before = held.get(row.key);
  held.set(row.key, row);
  if (before?.value !== row.value) notify(home, row.key);
}

function drop(home: string, key: string) {
  if (rows.get(home)?.delete(key)) notify(home, key);
}

function bridge() {
  if (bridged) return;
  bridged = true;
  client.on("settings-changed", (payload, env) => {
    const home = env ?? LOCAL_ENV;
    for (const row of (payload as SettingsChanged).rows) {
      const held = rows.get(home)?.get(row.key);
      if (!held || row.revision >= held.revision) hold(home, row);
    }
  });
}

/** One read per machine; a failed one is tried again by the next to ask. */
function load(home: string): Promise<void> {
  bridge();
  let loading = loads.get(home);
  if (!loading) {
    loading = client.request<SettingRow[]>("settings_list", {}, home).then(
      (list) => {
        for (const row of list) if (!writing.has(slot(home, row.key))) hold(home, row);
      },
      (error: unknown) => {
        loads.delete(home);
        throw error;
      },
    );
    loads.set(home, loading);
  }
  return loading;
}

/** From the moment the window opens: machines that come back are repaired whatever page is showing. */
export function startSettings(keys: string[]): () => void {
  globalKeys = keys;
  void load(LOCAL_ENV).catch(() => {});
  const offConnected = onConnected(() => reconciler.kick());
  const offLinks = subscribeLinks(() => reconciler.publish());
  reconciler.start();
  return () => {
    offConnected();
    offLinks();
    reconciler.stop();
  };
}

/** The machine a setting is read from and written to: its own for `env`, this one otherwise. */
function homeOf<T>(def: SettingDef<T>, env?: string): string {
  if (def.scope !== "env") return LOCAL_ENV;
  if (!env) throw new Error(`The setting ${def.key} is per machine: say which.`);
  return env;
}

/** What is held now, or the default before the first read. The same value until the stored one changes. */
export function peekSetting<T>(def: SettingDef<T>, options: EnvOption = {}): T {
  const home = homeOf(def, options.env);
  const raw = rows.get(home)?.get(def.key)?.value ?? null;
  const at = slot(home, def.key);
  const kept = parsed.get(at);
  if (kept && kept.raw === raw) return kept.value as T;
  const value = def.parse(raw);
  parsed.set(at, { raw, value });
  return value;
}

/** The value once the machine has answered. Rejects if it could not. */
export async function readSetting<T>(def: SettingDef<T>, options: EnvOption = {}): Promise<T> {
  await load(homeOf(def, options.env));
  return peekSetting(def, options);
}

/** Whether the machine holds a choice for it, the default chosen included. */
export async function hasSetting<T>(def: SettingDef<T>, options: EnvOption = {}): Promise<boolean> {
  const home = homeOf(def, options.env);
  await load(home);
  return rows.get(home)?.has(def.key) ?? false;
}

export function watchSetting<T>(def: SettingDef<T>, watcher: () => void, options: EnvOption = {}): () => void {
  bridge();
  const at = slot(homeOf(def, options.env), def.key);
  let set = watchers.get(at);
  if (!set) {
    set = new Set();
    watchers.set(at, set);
  }
  set.add(watcher);
  return () => set.delete(watcher);
}

/** Stored, then carried to the other machines. It rejects if the daemon did not keep it; the value shown goes back. */
export async function setSetting<T>(def: SettingDef<T>, value: T, options: EnvOption = {}): Promise<void> {
  const home = homeOf(def, options.env);
  const at = slot(home, def.key);
  const before = rows.get(home)?.get(def.key);
  const raw = def.format(value);
  writing.add(at);
  hold(home, { key: def.key, value: raw, scope: def.scope, revision: before?.revision ?? 0, origin: before?.origin ?? "" });
  try {
    hold(home, await client.request<SettingRow>("settings_set", { key: def.key, value: raw, scope: def.scope }, home));
  } catch (error) {
    if (before) hold(home, before);
    else drop(home, def.key);
    throw error;
  } finally {
    writing.delete(at);
  }
  if (def.scope === "global") reconciler.kick();
}

/** `setSetting` for a control with nothing to say itself: a failure goes to `onSettingSaveFailed`. */
export function saveSetting<T>(def: SettingDef<T>, value: T, options: EnvOption = {}): void {
  setSetting(def, value, options).catch((error: unknown) => {
    for (const listener of failureListeners) listener(def.key, error);
  });
}

export function onSettingSaveFailed(listener: (key: string, error: unknown) => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

export function useSetting<T>(def: SettingDef<T>, options: EnvOption = {}): T {
  const env = options.env;
  const subscribe = useCallback((watcher: () => void) => watchSetting(def, watcher, env ? { env } : {}), [def, env]);
  return useSyncExternalStore(subscribe, () => peekSetting(def, env ? { env } : {}));
}

export function useSettingsSync(): MachineSync[] {
  return useSyncExternalStore(reconciler.subscribe, reconciler.read);
}
