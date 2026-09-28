import type { EnvLink } from "./client/registry";

/** How a link reads in a word or two: its latency when it is up. */
export function statusText(link: EnvLink): string {
  if (link.mismatch) return "Needs update";
  if (link.status === "online") return link.latency !== null ? `${link.latency} ms` : "Online";
  if (link.status === "connecting") return "Connecting…";
  return "Offline";
}

/** How ssh reaches it: `user@alias` from ~/.ssh/config, or `user@host`. */
export function whereOf(link: EnvLink): string {
  const target = link.ssh ?? link.host;
  if (!target) return "";
  return link.user ? `${link.user}@${target}` : target;
}
