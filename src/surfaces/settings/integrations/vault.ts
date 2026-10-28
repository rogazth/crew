// The vault between machines, as the window runs it (plan
// docs/plans/2026-10-23-integrations.md, phase 3). One machine holds the
// sign-ins; the window, which reaches every machine, joins the others to it:
// it asks the vault for a lease token for each and hands it over. Moving the
// vault is three calls, new ← old: the new vault's key, the old vault's handoff
// token for that key, the new vault pulling with it; the window carries the
// key and the token, never a grant. Then every other machine joins the new one.
import { useSyncExternalStore } from "react";
import {
  getVaultEnv,
  setVaultEnv,
  stateGet,
  stateSet,
  vaultHandoff,
  vaultJoin,
  vaultListen,
  vaultMint,
  vaultMoveEmpty,
  vaultMoveOpen,
  vaultMovePull,
  vaultRevoke,
  vaultStatus,
} from "../../../lib/api";
import { getLinks, subscribeLinks, type EnvLink } from "../../../lib/client/registry";
import { LOCAL } from "../../../lib/client/route";
import { remotesHost } from "../../../lib/host";
import type { VaultStatus } from "../../../lib/protocol";
import { DEFAULT_PORT, isLoopback } from "../../../lib/remotes";

/** This Mac's preference: the machine that is the vault. */
export const VAULT_STATE = "integrations:vault";

export type Machine = {
  envId: string;
  name: string;
  online: boolean;
  /** Where the other machines reach it; null when they can't (no Tailscale, an ssh tunnel). */
  address: string | null;
  status: VaultStatus | null;
};

type State = { vaultEnv: string; machines: Machine[]; busy: string | null; error: string | null };

let state: State = { vaultEnv: LOCAL, machines: [], busy: null, error: null };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

export function useVault(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nameOf = (link: EnvLink) => (link.id === LOCAL ? "this Mac" : link.name);
export const machineName = (envId: string) => {
  const link = getLinks().find((l) => l.id === envId);
  return link ? nameOf(link) : envId;
};

/** This Mac's tailnet address, where the machines lease from it when it is the vault. */
async function macAddress(): Promise<string | null> {
  const net = await remotesHost()
    ?.tailnet()
    .catch(() => null);
  const ip = net?.devices.find((d) => d.self)?.ip;
  // The port the build's remotes listen on: free on this Mac, which runs no `crewd serve`.
  const port = getLinks().find((l) => l.id !== LOCAL && l.port)?.port ?? DEFAULT_PORT;
  return ip ? `${ip}:${port}` : null;
}

async function addressOf(link: EnvLink): Promise<string | null> {
  if (link.id === LOCAL) return macAddress();
  if (!link.host || !link.port || isLoopback(link.host)) return null;
  return `${link.host}:${link.port}`;
}

/** Each machine's place: reads every daemon the window reaches. */
export async function refreshVault(): Promise<void> {
  const links = getLinks();
  const machines = await Promise.all(
    links.map(async (link): Promise<Machine> => {
      const online = link.id === LOCAL || link.status === "online";
      const status = online ? await vaultStatus(link.id).catch(() => null) : null;
      return { envId: link.id, name: nameOf(link), online, address: await addressOf(link), status };
    }),
  );
  set({ machines });
}

/** The vault this Mac remembers; a machine that was removed gives it back to this Mac. */
export async function loadVault(): Promise<string> {
  const kept = await stateGet(VAULT_STATE).catch(() => null);
  const env = kept && (kept === LOCAL || getLinks().some((l) => l.id === kept)) ? kept : LOCAL;
  setVaultEnv(env);
  set({ vaultEnv: env });
  return env;
}

/** Joins `member` to the vault: a lease token minted for it, handed over. Its old tokens are revoked. */
async function join(member: EnvLink, vault: EnvLink, vaultAddress: string) {
  const old = await vaultStatus(vault.id).catch(() => null);
  for (const machine of old?.machines.filter((m) => m.name === nameOf(member)) ?? []) await vaultRevoke(vault.id, machine.id);
  const minted = await vaultMint(vault.id, nameOf(member));
  await vaultJoin(member.id, { address: vaultAddress, token: minted.token, vaultName: nameOf(vault) });
}

let ensuring: Promise<void> | null = null;

/**
 * Every machine online leases from the vault: one that holds no sign-ins of
 * its own, or leases from another address, joins it. One that holds
 * sign-ins of its own is left as it is: moving them is the person's call.
 */
export function ensureMembers(): Promise<void> {
  ensuring ??= (async () => {
    try {
      const links = getLinks();
      const vault = links.find((l) => l.id === getVaultEnv());
      if (!vault || (vault.id !== LOCAL && vault.status !== "online")) return;
      const others = links.filter((l) => l.id !== vault.id && (l.id === LOCAL || l.status === "online"));
      if (others.length === 0) return;
      const address = await addressOf(vault);
      if (!address) return;
      if (vault.id === LOCAL) await vaultListen(LOCAL, address);
      for (const member of others) {
        const status = await vaultStatus(member.id).catch(() => null);
        if (!status) continue;
        const stray = status.holds ? status.grants === 0 : status.vaultAddress !== address;
        if (stray) await join(member, vault, address).catch((e) => console.warn(`vault: ${nameOf(member)} didn't join: ${message(e)}`));
      }
      // A machine removed from Crew leases no more.
      const names = new Set(links.map(nameOf));
      const leasing = (await vaultStatus(vault.id).catch(() => null))?.machines ?? [];
      for (const gone of leasing.filter((m) => !names.has(m.name))) await vaultRevoke(vault.id, gone.id).catch(() => {});
    } finally {
      ensuring = null;
      void refreshVault();
    }
  })();
  return ensuring;
}

let watching = false;
/** Joins machines as they come online, for as long as the window lives. */
export function watchMembers() {
  if (watching) return;
  watching = true;
  let online = "";
  subscribeLinks(() => {
    const now = getLinks()
      .filter((l) => l.status === "online")
      .map((l) => l.id)
      .join(",");
    if (now === online) return;
    online = now;
    void ensureMembers();
  });
}

/**
 * Makes `to` the vault. With the old vault online the sign-ins move, sealed
 * to `to`'s key; offline, `to` starts empty and every account asks for a
 * sign-in. Then every other machine joins `to`. `onMoved` is told the vault's
 * new place, so the connectors are read from there.
 */
export async function moveVault(to: string, onMoved: () => void): Promise<void> {
  const links = getLinks();
  const target = links.find((l) => l.id === to);
  const from = links.find((l) => l.id === getVaultEnv());
  if (!target) throw new Error("That machine is gone.");
  set({ busy: to, error: null });
  try {
    const address = await addressOf(target);
    const others = links.filter((l) => l.id !== to);
    if (!address && others.length > 0) throw new Error(`The other machines can’t reach ${nameOf(target)}: it has no Tailscale address.`);
    const fromOnline = !!from && (from.id === LOCAL || from.status === "online");
    if (from && fromOnline) {
      const fromAddress = await addressOf(from);
      if (!fromAddress) throw new Error(`${nameOf(target)} can’t reach ${nameOf(from)} to take the sign-ins.`);
      if (from.id === LOCAL) await vaultListen(LOCAL, fromAddress);
      const key = await vaultMoveOpen(to);
      const { token } = await vaultHandoff(from.id, key);
      await vaultMovePull(to, { address: fromAddress, token });
    } else {
      await vaultMoveEmpty(to);
    }
    await stateSet(VAULT_STATE, to);
    setVaultEnv(to);
    set({ vaultEnv: to });
    onMoved();
    if (address) {
      if (to === LOCAL) await vaultListen(LOCAL, address);
      for (const member of others.filter((l) => l.id === LOCAL || l.status === "online")) {
        await join(member, target, address).catch((e) => console.warn(`vault: ${nameOf(member)} didn't join: ${message(e)}`));
      }
    }
  } catch (error) {
    set({ error: message(error) });
    throw error;
  } finally {
    set({ busy: null });
    void refreshVault();
  }
}
