/**
 * What the updater in main and the window agree on. Imported by both sides
 * (esbuild bundles it into main and the preload), so it stays free of DOM and
 * Electron.
 */

export const UPDATE_CHANNELS = {
  /** main → window: the updater moved to a new phase, or a download advanced. */
  state: "update:state",
  /** window → main: the phase right now, for a window that opens mid-update. */
  current: "update:current",
  /** window → main: look for a newer release now, whatever the schedule says. */
  check: "update:check",
  /** window → main: download and stage the offered release. */
  download: "update:download",
  /** window → main: apply the staged release and relaunch. */
  restart: "update:restart",
  /** window → main: an offered version is not offered again until asked; anything else goes back to idle. */
  dismiss: "update:dismiss",
  cancel: "update:cancel",
  /** window → main: the "download automatically" preference, which the window persists. */
  auto: "update:auto",
  /** main → window: the menu asked for a check; show the About page. */
  show: "update:show",
  /** window → main: the published releases, newest first. */
  releases: "update:releases",
} as const;

export type ReleaseNote = { kind: "new" | "improved" | "fixed"; text: string };

/** What a release offers. `size` and `date` come from the manifest and may be missing from older ones. */
export type UpdateOffer = {
  version: string;
  /** The version running now. */
  current: string;
  /** Bytes of the download. */
  size: number | null;
  /** ISO date the release was cut. */
  date: string | null;
  notes: ReleaseNote[];
};

export type UpdatePhase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest"; version: string }
  /** A checkout build: there is no installed bundle to replace. */
  | { phase: "unpackaged" }
  | { phase: "available"; offer: UpdateOffer }
  /** `total` is null when the server sends no length. */
  | { phase: "downloading"; offer: UpdateOffer; received: number; total: number | null }
  /** Downloaded and verified; unpacking the bundle next to the installed one. */
  | { phase: "staging"; offer: UpdateOffer }
  /** Staged. Restarting applies it, and so does quitting. */
  | { phase: "ready"; offer: UpdateOffer }
  | { phase: "restarting"; offer: UpdateOffer }
  | { phase: "error"; message: string };

/** The phase, and when the release feed was last read (epoch ms; null before the first check). */
export type UpdateState = UpdatePhase & { checkedAt: number | null };

/** One published release, for "What's new". */
export type PublishedRelease = {
  version: string;
  /** ISO date. */
  date: string;
  url: string;
  notes: ReleaseNote[];
};

export type ReleaseList = {
  releases: PublishedRelease[];
  /** From the cache: the feed could not be reached. */
  stale: boolean;
};

const KINDS: Record<string, ReleaseNote["kind"] | null> = {
  feat: "new",
  fix: "fixed",
  refactor: "improved",
  perf: "improved",
  // Housekeeping is not news.
  chore: null,
  docs: null,
  test: null,
  style: null,
  ci: null,
  build: null,
};

/** `feat: subject` → a "new" note; a line with no known prefix reads as an improvement. */
export function noteOf(line: string): ReleaseNote | null {
  const match = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(line.trim());
  const kind = match ? KINDS[match[1]!.toLowerCase()] : "improved";
  if (kind === null || kind === undefined) return null;
  const text = (match ? match[2]! : line.trim()).trim();
  return text ? { kind, text: text.charAt(0).toUpperCase() + text.slice(1) } : null;
}

/**
 * The bullets of a release body. GitHub's generated notes end each with
 * "by @user in <url>", and close with a "Full Changelog" line; both go.
 */
export function notesOf(body: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const raw of body.split("\n")) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(raw);
    if (!bullet) continue;
    const line = bullet[1]!.replace(/\s+by @\S+\s+in\s+\S+\s*$/, "").replace(/\*\*/g, "");
    if (/^full changelog/i.test(line)) continue;
    const note = noteOf(line);
    if (note) notes.push(note);
  }
  return notes;
}

/** Bytes as the download size reads: "48.6 MB". */
export function sizeLabel(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** An ISO date as the release dates read: "October 17, 2026". */
export function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
