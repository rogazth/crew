// A connector's copies in the providers' own configs (outside.tsx): each
// CLI's servers on each machine whose URL is the connector's, however they got
// there. Signing in and removing are the CLI's server's own.
import { useEffect, useSyncExternalStore } from "react";
import { useEnvLinks } from "../../../hooks/useEnvLinks";
import { LOCAL } from "../../../lib/client/registry";
import type { Connector } from "../../../lib/protocol";
import { serverActions, serversNeedYou, subscribeServers, useAllMachines, watchMachine } from "./providers";
import { accountsNeedYou, getState, subscribeConnectors } from "./store";
import { isBundled, isOff, perSpawn, type Server } from "./servers";

export type CopyState = "adding" | "needs-auth" | "signing-in" | "connected" | "failed" | "off" | "added" | "removing";
/** One copy: a CLI's server with a connector's URL, on one machine. */
export type Copy = { url: string; envId: string; provider: string; state: CopyState; server: Server };

/** The same server: case of the host and a trailing slash aside, as crewd compares them. */
export const sameUrl = (a: string, b: string) => {
  const norm = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
};


export function signInCopy(copy: Copy) {
  serverActions.signIn(copy.envId, copy.server);
}
export function removeCopy(copy: Copy) {
  serverActions.remove(copy.envId, copy.server);
}
/** Leaves a copy out of Crew's sessions, so they get only Crew's connector. */
export function turnOffInCrew(copy: Copy) {
  serverActions.setOff(copy.envId, copy.server, true);
}

/* ── Reading ─────────────────────────────────────────────────────────── */

/** Reads every machine's lists, so the copies on each show. */
export function useWatchMachines() {
  const links = useEnvLinks();
  const key = (links.length ? links.map((l) => l.id) : [LOCAL]).join("\u0000");
  useEffect(() => {
    for (const id of key.split("\u0000")) watchMachine(id);
  }, [key]);
}

function stateOf(server: Server, busy: ReturnType<ReturnType<typeof useAllMachines>["busy"]>): CopyState {
  if (busy === "signing-in") return "signing-in";
  if (busy === "removing") return "removing";
  if (busy === "starting") return "adding";
  if (isOff(server)) return "off";
  switch (server.state) {
    case "needs_auth":
      return "needs-auth";
    case "connected":
      return "connected";
    case "failed":
      return "failed";
    case "pending":
      return "adding";
    default:
      return "added";
  }
}

/** Every copy of every server URL on every machine this window has lists for. */
export function useCopies() {
  const { machines, busy } = useAllMachines();
  const copies: Copy[] = [];
  for (const [envId, machine] of Object.entries(machines)) {
    for (const inventory of machine.inventory) {
      for (const server of inventory.servers) {
        if (isBundled(server) || !/^https?:\/\//.test(server.target)) continue;
        copies.push({ url: server.target, envId, provider: server.provider, state: stateOf(server, busy(envId, server)), server });
      }
    }
  }
  return { copies };
}

/**
 * The copies that clash with a connector: the same server, still loaded in
 * Crew's sessions, so its tools show up twice.
 */
export const conflictsOf = (connector: Connector, copies: Copy[]) =>
  copies.filter((c) => sameUrl(c.url, connector.url) && !isOff(c.server) && c.state !== "removing");

const subscribeAll = (listener: () => void) => {
  const off = [subscribeConnectors(listener), subscribeServers(listener)];
  return () => off.forEach((stop) => stop());
};

/**
 * Whether anything behind the Connectors page needs the person: an account
 * signed out or refused, a CLI's server waiting on a sign-in, or a copy that
 * clashes with a connector. The rail's icon wears a dot.
 */
export function useConnectorsAlert(): boolean {
  return useSyncExternalStore(subscribeAll, () => {
    const s = getState();
    return accountsNeedYou(s) || serversNeedYou(s.connectors.map((c) => c.url), sameUrl);
  });
}

/** Whether a CLI can leave a copy out of Crew's sessions alone, without turning it off outside Crew too. */
export const canTurnOffInCrew = (copy: Copy) => perSpawn(copy.provider);

/** Where each provider keeps its user-wide servers: what the sheet says it writes. */
export const CONFIG: Record<string, string> = {
  claude: "~/.claude.json",
  codex: "~/.codex/config.toml",
  cursor: "~/.cursor/mcp.json",
  opencode: "~/.config/opencode/opencode.json",
  grok: "~/.grok/config.toml",
};
