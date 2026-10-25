import type { SettingsSectionId } from "./settings";

export const LAST_MACHINE = "remote:last";
export const WARN_RELAY = "remote:warn-relay";
export const WAKE_ON = "remote:wake";

export function recentKey(envId: string): string {
  return `remote:recent:${envId}`;
}

type OpenOn = (envId: string) => void;
let openOn: OpenOn | null = null;

/** The window's ⌘O picker, started on one machine's folders. */
export function setOpenWorkspaceOn(fn: OpenOn | null) {
  openOn = fn;
}

export function openWorkspaceOn(envId: string) {
  openOn?.(envId);
}

type OpenSettings = (section: SettingsSectionId) => void;
let settingsOpener: OpenSettings | null = null;

export function setSettingsOpener(fn: OpenSettings | null) {
  settingsOpener = fn;
}

/** For a banner deep in the workspace that points at Settings. */
export function openSettingsSection(section: SettingsSectionId) {
  settingsOpener?.(section);
}

type ServerSignIn = { provider: string; server: string; command: string[] };
type OpenServerSignIn = (envId: string, signIn: ServerSignIn) => Promise<void>;
let serverSignInOpener: OpenServerSignIn | null = null;

export function setServerSignInOpener(fn: OpenServerSignIn | null) {
  serverSignInOpener = fn;
}

/**
 * A provider server's login, in a terminal tab on the machine whose CLI uses
 * it; its end has that machine read its servers again. Rejects when there is
 * no window to open it in, or the machine is not connected.
 */
export function openServerSignIn(envId: string, signIn: ServerSignIn): Promise<void> {
  if (!serverSignInOpener) return Promise.reject(new Error("Signing in from a terminal needs the Crew app"));
  return serverSignInOpener(envId, signIn);
}

let adding = false;
const addWatchers = new Set<() => void>();

/** Settings › Environments opens its add flow on the next paint. */
export function requestAddRemote() {
  adding = true;
  for (const watcher of addWatchers) watcher();
}

export function takeAddRequest(): boolean {
  const value = adding;
  adding = false;
  return value;
}

export function subscribeAdd(listener: () => void): () => void {
  addWatchers.add(listener);
  return () => {
    addWatchers.delete(listener);
  };
}
