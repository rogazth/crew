import { liveSource, sourceFromLocation, type DataSource } from "@crew/fixtures";

/**
 * One data source for the whole prototype, chosen from the URL:
 *
 *   (nothing)        the demo fixtures
 *   ?stress=heavy    400 sessions, 20k files, 5000-block transcripts
 *   ?source=live     a real `crewd` over its own WebSocket
 *
 * Everything the shell reads goes through this, so "which world am I in" is one
 * line rather than a flag threaded through every surface.
 */
export const source: DataSource = sourceFromLocation(
  typeof location === "undefined" ? "" : location.search,
  () => liveSource(),
);

export const sourceLabel = source.label;
