import type { Channel } from "./remote-ssh";

/**
 * Which build this is: the published release, a package built here, or a dev
 * build. Everything a build keeps outside its data dir is named for its
 * channel, so two builds on one Mac never share it: the keychain item (from
 * the app's name), the `crew` link on the PATH, a remote machine's unit, folder
 * and port.
 */
export function channelOf(packaged: boolean, release: boolean): Channel {
  if (!packaged) return "dev";
  return release ? "release" : "local";
}

/** The app's name, which also names its key in the login keychain. */
export function appName(channel: Channel): string {
  return { release: "Crew", local: "Crew Local", dev: "Crew Dev" }[channel];
}

/** The command the Command line setting links onto the PATH. */
export function cliLinkName(channel: Channel): string {
  return { release: "crew", local: "crew-local", dev: "crew-dev" }[channel];
}
