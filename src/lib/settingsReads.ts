// What the settings pages read from crewd and the host, kept between visits
// and read ahead as Settings opens: a page paints with the values it keeps,
// not with defaults that flip a frame later and push the rows under them.
import { useEffect, useSyncExternalStore } from "react";
import * as api from "./api";
import type { CliStatus } from "./cli";
import { appInfo, cliHost, homeDir, loginItemHost, notificationStatus, remotesHost, updateHost } from "./host";
import type { LoginItemState } from "./loginItem";
import type { BannerState } from "./notify";
import { BYPASS_KEY } from "./permissions";
import { RETENTION_KEY } from "./retention";
import type { Tailnet } from "./remotes";
import { WAKE_ON, WARN_RELAY } from "./remoteUi";
import { REOPEN_KEY } from "./startup";
import type { ReleaseList, UpdateState } from "./update";

export type Read<T> = { key: string; load: () => Promise<T> };

const values = new Map<string, unknown>();
const running = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reads it again; a read already on its way is shared. A failed read keeps what was there. */
export function refresh(read: Read<unknown>): Promise<void> {
  const already = running.get(read.key);
  if (already) return already;
  const run = read
    .load()
    .then(
      (value) => {
        values.set(read.key, value);
        emit();
      },
      () => {},
    )
    .finally(() => running.delete(read.key));
  running.set(read.key, run);
  return run;
}

/** The last value read, or undefined before the first read lands. */
export function peek<T>(read: Read<T>): T | undefined {
  return values.get(read.key) as T | undefined;
}

/** What was just saved, so the next page to show it paints it. */
export function keep<T>(read: Read<T>, value: T): void {
  values.set(read.key, value);
  emit();
}

/** The kept value, following `keep` and `refresh`. */
export function useKept<T>(read: Read<T>): T | undefined {
  return useSyncExternalStore(subscribe, () => peek(read));
}

/** The kept value at once, read again as the caller mounts. */
export function useRead<T>(read: Read<T>): T | undefined {
  useEffect(() => void refresh(read), [read]);
  return useKept(read);
}

const state = (key: string): Read<string | null> => ({ key: `state:${key}`, load: () => api.stateGet(key) });

const none = () => Promise.resolve(null);

export const READS = {
  retention: state(RETENTION_KEY),
  bypass: state(BYPASS_KEY),
  reopen: state(REOPEN_KEY),
  warnRelay: state(WARN_RELAY),
  wake: state(WAKE_ON),
  login: { key: "login", load: (): Promise<LoginItemState | null> => loginItemHost()?.get() ?? none() },
  cli: { key: "cli", load: (): Promise<CliStatus | null> => cliHost()?.status() ?? none() },
  home: { key: "home", load: homeDir },
  appInfo: { key: "app-info", load: appInfo },
  update: { key: "update", load: (): Promise<UpdateState | null> => updateHost()?.current() ?? none() },
  // A feed that cannot be reached answers from main's cache; with none, an empty stale list.
  releases: {
    key: "releases",
    load: (): Promise<ReleaseList | null> =>
      updateHost()?.releases().catch(() => ({ releases: [], stale: true })) ?? none(),
  },
  tailnet: { key: "tailnet", load: (): Promise<Tailnet | null> => remotesHost()?.tailnet() ?? none() },
  banners: { key: "banners", load: (): Promise<BannerState> => notificationStatus() },
} satisfies Record<string, Read<unknown>>;

let warmed = false;

/** True once Settings has read ahead, or given up waiting. */
export const settingsWarm = () => warmed;

/**
 * Reads everything the pages show, waiting at most `ms`: a slow read (the
 * release feed, Tailscale) lands on its own, below what is already painted.
 */
export function warmSettings(ms = 400): Promise<void> {
  const all = Promise.all(Object.values(READS).map((read) => refresh(read)));
  return Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, ms))]).then(() => {
    warmed = true;
  });
}
