import { useMemo, useSyncExternalStore } from "react";
import { machineAliases } from "../lib/browser/machines";
import { LOCAL, envOf, getLinks, linkOf, subscribeLinks, type EnvLink } from "../lib/client/registry";

/** One row per daemon the window is talking to, this Mac's included. Re-renders on every latency tick. */
export function useEnvLinks(): EnvLink[] {
  return useSyncExternalStore(subscribeLinks, getLinks);
}

/** The same rows, but only re-rendering when a machine comes, goes or changes state: not on latency. */
export function useEnvStates(): EnvLink[] {
  const signature = useSyncExternalStore(subscribeLinks, stateSignature);
  // The signature is the dependency: a new one means new rows to read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getLinks(), [signature]);
}

function stateSignature(): string {
  return getLinks()
    .map((link) => [link.id, link.name, link.status, link.mismatch, link.home, link.socksPort, link.host, link.user].join(":"))
    .join("|");
}

/**
 * The machine a workspace lives on, re-rendering only when its state changes.
 * Null on this Mac, whose daemon the app keeps up itself.
 */
export function useWorkspaceLink(workspaceId: string | null): EnvLink | null {
  const key = useSyncExternalStore(subscribeLinks, () => {
    const env = workspaceId ? envOf(workspaceId) : LOCAL;
    if (env === LOCAL) return "";
    const link = linkOf(env);
    return link ? [env, link.status, link.mismatch, link.error ?? ""].join("|") : env;
  });
  return useMemo(() => (key ? linkOf(key.split("|")[0] ?? "") : null), [key]);
}

/** Each other machine's alias, by its id: the name its pages reach its loopback at. */
export function remoteAliases(links: EnvLink[]): Map<string, string> {
  return machineAliases(links.filter((link) => link.id !== LOCAL));
}

/**
 * The alias of the machine a workspace lives on: null on this Mac, undefined
 * while the machine is not known yet, so a page waits rather than loading
 * this Mac's `localhost` in its place.
 */
export function useWorkspaceMachine(workspaceId: string): string | null | undefined {
  const key = useSyncExternalStore(subscribeLinks, () => {
    const env = envOf(workspaceId);
    if (env === LOCAL) return "local";
    return remoteAliases(getLinks()).get(env) ?? "unknown";
  });
  return key === "local" ? null : key === "unknown" ? undefined : key;
}
