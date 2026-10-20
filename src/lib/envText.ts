import type { EnvLink } from "./client/registry";

/** How a link reads in a word or two: its latency when it is up. */
export function statusText(link: EnvLink): string {
  if (link.mismatch) return "Needs update";
  if (link.status === "online") return link.latency !== null ? `${link.latency} ms` : "Online";
  if (link.status === "connecting") return "Connecting…";
  return "Offline";
}

/** How ssh reaches it: `user@alias` from ~/.ssh/config, `user@host`, or `ssh://user@host:port`. */
export function whereOf(link: EnvLink): string {
  const target = link.ssh ?? link.host;
  if (!target) return "";
  if (target.startsWith("ssh://")) {
    const rest = target.slice("ssh://".length);
    return link.user && !rest.includes("@") ? `ssh://${link.user}@${rest}` : target;
  }
  return link.user ? `${link.user}@${target}` : target;
}

/** The bare host of an ssh target: no `ssh://`, user or port. */
export function bareHost(target: string): string {
  const rest = target.replace(/^ssh:\/\//, "");
  const host = rest.slice(rest.lastIndexOf("@") + 1);
  return host.replace(/:\d+$/, "");
}
