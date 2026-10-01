/**
 * The `crew` command on this Mac's PATH, as main and the General settings
 * agree on it. Imported by both sides, so it stays free of DOM and Electron.
 */

export const CLI_CHANNELS = {
  status: "cli:status",
  install: "cli:install",
  uninstall: "cli:uninstall",
} as const;

export type CliStatus =
  /** The build carries no `crew` to link to: a checkout that has not built it. */
  | { state: "unavailable"; source: string }
  | { state: "absent"; dir: string }
  /** `onPath` is whether the user's shell looks in the link's folder. */
  | { state: "installed"; link: string; onPath: boolean };

/** What install and uninstall come back with: where things stand, and what went wrong if anything did. */
export type CliResult = { status: CliStatus; error?: string | undefined };

export function describeCli(status: CliStatus): string {
  const what = "Lets you run crew from your own terminal. Agents in Crew reach it without this.";
  switch (status.state) {
    case "unavailable":
      return "This build has no crew command to link. Build it with: cargo build -p crew-cli";
    case "absent":
      return `${what} It links into ${status.dir}.`;
    case "installed":
      return status.onPath
        ? `${what} Linked at ${status.link}.`
        : `Linked at ${status.link}, but that folder is not on your shell's PATH yet; add it to use crew by name.`;
  }
}
