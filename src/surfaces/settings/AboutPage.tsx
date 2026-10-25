// About: Crew's own page. The update card runs on the real updater, the build
// table on the app's own versions, "What's new" on the published releases.
import { Collapsible } from "@base-ui/react/collapsible";
import {
  ArrowDownToLineIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  LoaderCircleIcon,
  RotateCwIcon,
  ScaleIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { CrewGlyph } from "../../chrome/CrewGlyph";
import { Button, IconButton, Overlay, Switch } from "../../chrome/kit";
import { useAppInfo, useAutoDownload, useReleases, useUpdateActions, useUpdateState } from "../../hooks/useUpdate";
import { useNow } from "../../hooks/useNow";
import type { AppInfo } from "../../lib/appInfo";
import { openLicenses, openUrl } from "../../lib/host";
import { dateLabel, sizeLabel, type ReleaseNote } from "../../lib/update";
import { Chip, CopyButton, Heading, ProgressBar, RAISED, SettingsPage, toast, type Tone } from "./ui";

const REPO_URL = "https://github.com/rogazth/crew";

const KIND: Record<ReleaseNote["kind"], { label: string; tone: Tone }> = {
  new: { label: "New", tone: "info" },
  improved: { label: "Improved", tone: "neutral" },
  fixed: { label: "Fixed", tone: "neutral" },
};

const UNKNOWN = "Unknown";

export function AboutPage() {
  const info = useAppInfo();
  const [credits, setCredits] = useState(false);
  return (
    <SettingsPage title="About" hideHeader>
      <Hero info={info} />
      <UpdateCard />
      <Build info={info} />
      <Changelog current={info?.version ?? null} />
      <Links info={info} />
      <p className="flex flex-col items-center gap-0.5 pt-2 text-center text-[12px] text-text-muted">
        <span>Made by Gabriel Rodriguez, with a crew of agents.</span>
        <span className="text-placeholder">
          © 2026 Crew ·{" "}
          <button type="button" onClick={() => setCredits(true)} className="text-text-muted hover:text-text hover:underline">
            Acknowledgements
          </button>
        </span>
      </p>
      {credits && <Credits onClose={() => setCredits(false)} />}
    </SettingsPage>
  );
}

function Hero({ info }: { info: AppInfo | null }) {
  return (
    <header className="relative flex flex-col items-center gap-4 pt-6 pb-2 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-accent)_12%,transparent),transparent)] blur-xl"
      />
      <span className={`relative grid size-24 place-items-center rounded-[28px] ${RAISED}`}>
        <CrewGlyph className="size-16" />
      </span>
      <div className="relative flex flex-col items-center gap-1">
        <h1 className="text-[30px] leading-9 font-semibold tracking-[-0.03em]">Crew</h1>
        <p className="text-[14px] text-text-muted">Coding agents in your worktrees.</p>
      </div>
      {info && (
        <div className="relative flex items-center gap-2 text-[12px] text-text-muted">
          <span className="tabular-nums">Version {info.version}</span>
          {!info.release && (
            <>
              <span className="size-0.5 rounded-full bg-text-muted" />
              <Chip tone="warning" dot={false}>
                Local build
              </Chip>
            </>
          )}
          <span className="size-0.5 rounded-full bg-text-muted" />
          <span className="font-mono">{shortCommit(info.commit)}</span>
        </div>
      )}
    </header>
  );
}

const shortCommit = (commit: string) => (commit === "unknown" ? commit : commit.slice(0, 7));

/* ── The update ─────────────────────────────────────────────────────── */

/** "just now", "2 minutes ago", "3 hours ago". */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function Spinner() {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-card text-icon">
      <LoaderCircleIcon className="size-5 animate-spin motion-reduce:animate-none" />
    </span>
  );
}

function UpdateCard() {
  const state = useUpdateState();
  const { check, download, restart, skip, cancel } = useUpdateActions();
  const [auto, setAuto] = useAutoDownload();
  const info = useAppInfo();
  const now = useNow(30_000);
  const checked = state.checkedAt === null ? "not yet" : ago(state.checkedAt, now);
  const current = info?.version ?? "";

  let tile: ReactNode;
  let title: string;
  let line: string;
  let action: ReactNode;
  let progress: number | null = null;
  let notes: ReleaseNote[] = [];
  switch (state.phase) {
    case "available":
      tile = <Tile tone="accent" icon={ArrowDownToLineIcon} />;
      title = `Crew ${state.offer.version} available`;
      line = [state.offer.date && dateLabel(state.offer.date), state.offer.size && sizeLabel(state.offer.size)]
        .filter(Boolean)
        .join(" · ") || `You have ${state.offer.current}`;
      notes = state.offer.notes;
      action = (
        <>
          <Button variant="ghost" onClick={skip}>
            Skip
          </Button>
          <Button variant="primary" icon={ArrowDownToLineIcon} onClick={download}>
            Download
          </Button>
        </>
      );
      break;
    case "downloading": {
      tile = <Spinner />;
      title = `Downloading Crew ${state.offer.version}`;
      notes = state.offer.notes;
      progress = state.total ? state.received / state.total : null;
      line = state.total ? `${sizeLabel(state.received)} / ${sizeLabel(state.total)}` : sizeLabel(state.received);
      action = (
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      );
      break;
    }
    case "staging":
      tile = <Spinner />;
      title = `Preparing Crew ${state.offer.version}`;
      line = "Unpacking…";
      notes = state.offer.notes;
      action = null;
      break;
    case "ready":
      tile = <Tile tone="accent" icon={RotateCwIcon} solid />;
      title = `Crew ${state.offer.version} is ready`;
      line = "Restart to install, or it installs when you quit.";
      notes = state.offer.notes;
      action = (
        <Button variant="primary" icon={RotateCwIcon} onClick={restart}>
          Restart to install
        </Button>
      );
      break;
    case "restarting":
      tile = <Spinner />;
      title = `Restarting into Crew ${state.offer.version}`;
      line = "Reopening…";
      action = null;
      break;
    case "checking":
      tile = <Spinner />;
      title = "Checking…";
      line = "Asking GitHub for the latest release";
      action = (
        <Button icon={RotateCwIcon} loading>
          Check now
        </Button>
      );
      break;
    case "unpackaged":
      tile = <Tile tone="success" icon={CheckIcon} />;
      title = "Updates need the installed app";
      line = "This build runs from a checkout.";
      action = null;
      break;
    case "error":
      tile = <Tile tone="danger" icon={TriangleAlertIcon} />;
      title = "Update failed";
      line = state.message;
      action = (
        <Button icon={RotateCwIcon} onClick={check}>
          Try again
        </Button>
      );
      break;
    default:
      tile = <Tile tone="success" icon={CheckIcon} />;
      title = "Up to date";
      line = `${current ? `${current} · ` : ""}checked ${checked}`;
      action = (
        <Button icon={RotateCwIcon} onClick={check}>
          Check now
        </Button>
      );
  }

  return (
    <section data-setting="updates" className="flex flex-col gap-1 rounded-[14px] bg-card p-2">
      <div className="flex items-center gap-3 px-2.5 pt-2.5 pb-2">
        {tile}
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-[15px] leading-5 font-semibold tracking-[-0.01em]">{title}</h2>
          <p className={`text-[12px] tabular-nums ${state.phase === "error" ? "line-clamp-2 text-danger" : "text-text-muted"}`}>
            {line}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{action}</div>
      </div>
      {state.phase === "downloading" && (
        <div className="px-2.5 pb-2">
          <ProgressBar value={progress ?? 0} />
        </div>
      )}
      {notes.length > 0 && <Notes notes={notes} />}
      <div className="rounded-xl bg-card px-3.5">
        <label data-setting="auto-download" className="flex min-h-11 cursor-pointer items-center gap-6 py-2">
          <div className="min-w-0 flex-1">
            <p>Download updates automatically</p>
            <p className="text-[12px] text-text-muted">Crew still asks before it restarts.</p>
          </div>
          <Switch checked={auto} onChange={setAuto} label="Download updates automatically" />
        </label>
      </div>
    </section>
  );
}

function Notes({ notes }: { notes: readonly ReleaseNote[] }) {
  return (
    <ul className="flex flex-col gap-2 rounded-xl bg-card p-3.5">
      {notes.map((note) => (
        <li key={note.text} className="flex items-start gap-2.5">
          <span className="w-[68px] shrink-0 pt-px">
            <Chip tone={KIND[note.kind].tone} dot={false}>
              {KIND[note.kind].label}
            </Chip>
          </span>
          <span>{note.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Tile({ tone, icon: Glyph, solid = false }: { tone: "accent" | "success" | "danger"; icon: LucideIcon; solid?: boolean }) {
  const look = solid
    ? "bg-accent text-inverse shadow-[0_6px_16px_-6px_var(--color-accent)]"
    : tone === "success"
      ? "bg-success/12 text-success"
      : tone === "danger"
        ? "bg-danger/10 text-danger"
        : "bg-accent/12 text-accent";
  return (
    <span className={`grid size-10 shrink-0 place-items-center rounded-[12px] ${look}`}>
      <Glyph className="size-5" />
    </span>
  );
}

/* ── Build, changelog, links ────────────────────────────────────────── */

/** What the build table lists, and what a bug report carries. */
function buildRows(info: AppInfo | null): [string, string][] {
  if (!info) return [];
  return [
    ["Version", `${info.version} (${info.arch})`],
    ["Commit", shortCommit(info.commit)],
    ["Electron", info.electron || UNKNOWN],
    ["Chromium", info.chrome || UNKNOWN],
    ["Node", info.node],
    ["Daemon", info.crewd ? `crewd ${info.crewd}` : UNKNOWN],
    ["OS", info.os],
  ];
}

function Build({ info }: { info: AppInfo | null }) {
  const rows = buildRows(info);
  const all = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  return (
    <section data-setting="build" className="flex flex-col gap-2">
      <Heading
        title="Build"
        description="Include in bug reports."
        action={
          <span className="flex items-center gap-1 text-[12px] text-text-muted">
            Copy all
            <CopyButton text={all} label="Copy build information" />
          </span>
        }
      />
      {rows.length === 0 ? (
        <p className="rounded-xl bg-card px-4 py-3 text-text-muted">Build details are available in the Crew app.</p>
      ) : (
      <dl className="grid grid-cols-1 gap-x-8 rounded-xl bg-card px-4 py-1.5 @[560px]:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex h-9 items-center justify-between gap-4 border-hairline [&:not(:nth-last-child(-n+2))]:border-b">
            <dt className="text-text-muted">{k}</dt>
            <dd className={`truncate tabular-nums ${k === "Commit" ? "font-mono text-[12px]" : ""}`} data-selectable>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      )}
    </section>
  );
}

function Changelog({ current }: { current: string | null }) {
  const { list, reload } = useReleases();
  // One release open at a time: opening another folds the last.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const releases = list?.releases ?? [];
  const open = picked === undefined ? (releases[0]?.version ?? null) : picked;
  return (
    <section data-setting="changelog" className="flex flex-col gap-2">
      <Heading
        title="What's new"
        {...(list?.stale && releases.length > 0 ? { description: "Offline: showing the last releases Crew saw." } : {})}
        action={
          <button
            type="button"
            onClick={() => void openUrl(`${REPO_URL}/releases`)}
            className="text-[12px] text-link hover:underline"
          >
            All releases
          </button>
        }
      />
      <div className="rounded-xl bg-card px-1.5 py-1.5">
        {list === null ? (
          <p className="flex h-10 items-center gap-2 px-2.5 text-text-muted">
            <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
            Loading releases…
          </p>
        ) : releases.length === 0 ? (
          <div className="flex min-h-10 items-center gap-3 px-2.5 py-1.5 text-text-muted">
            <span className="min-w-0 flex-1">
              {list.stale ? "Couldn’t reach GitHub. No release notes to show." : "No releases yet."}
            </span>
            <button type="button" onClick={reload} className="text-link hover:underline">
              Retry
            </button>
          </div>
        ) : (
          releases.map((release) => (
            <Collapsible.Root
              key={release.version}
              open={open === release.version}
              onOpenChange={(next) => setPicked(next ? release.version : null)}
            >
              <Collapsible.Trigger className="group flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none hover:bg-hover focus-visible:bg-hover">
                <ChevronRightIcon className="size-3.5 shrink-0 text-icon transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none" />
                <span className="font-medium tabular-nums">{release.version}</span>
                {release.version === current && (
                  <Chip tone="success" dot={false}>
                    Installed
                  </Chip>
                )}
                <span className="ml-auto text-[12px] text-text-muted">{dateLabel(release.date)}</span>
              </Collapsible.Trigger>
              <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
                <ul className="flex flex-col gap-2 pt-1 pr-3 pb-3 pl-8">
                  {release.notes.length === 0 && (
                    <li className="text-text-muted">
                      No notes were written for this release.{" "}
                      <button type="button" onClick={() => void openUrl(release.url)} className="text-link hover:underline">
                        Open on GitHub
                      </button>
                    </li>
                  )}
                  {release.notes.map((note) => (
                    <li key={note.text} className="flex items-start gap-2.5">
                      <span className="w-[68px] shrink-0 pt-px">
                        <Chip tone={KIND[note.kind].tone} dot={false}>
                          {KIND[note.kind].label}
                        </Chip>
                      </span>
                      <span className="text-text">{note.text}</span>
                    </li>
                  ))}
                </ul>
              </Collapsible.Panel>
            </Collapsible.Root>
          ))
        )}
      </div>
    </section>
  );
}

/** A new issue with the build already in the body. */
function issueUrl(info: AppInfo | null): string {
  const body = [
    "**What happened**",
    "",
    "",
    "**What you expected**",
    "",
    "",
    "**Build**",
    ...buildRows(info).map(([k, v]) => `- ${k}: ${v}`),
  ].join("\n");
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

function Links({ info }: { info: AppInfo | null }) {
  const links: { icon: LucideIcon; label: string; line: string; open: () => void }[] = [
    { icon: BookOpenIcon, label: "Documentation", line: "Guides and setup", open: () => void openUrl(`${REPO_URL}#readme`) },
    { icon: CodeXmlIcon, label: "GitHub", line: "Source and releases", open: () => void openUrl(REPO_URL) },
    { icon: BugIcon, label: "Report an issue", line: "Build info included", open: () => void openUrl(issueUrl(info)) },
    {
      icon: ScaleIcon,
      label: "Licenses",
      line: "Open source notices",
      open: () =>
        void openLicenses().then((problem) => {
          if (problem) toast(problem, "warning");
        }),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 @[620px]:grid-cols-4">
      {links.map(({ icon: Glyph, label, line, open }) => (
        <button
          key={label}
          type="button"
          onClick={open}
          className="flex flex-col items-start gap-2.5 rounded-xl bg-card p-3 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          <Glyph className="size-4 text-icon" />
          <span className="flex flex-col">
            <span className="font-medium">{label}</span>
            <span className="text-[12px] text-text-muted">{line}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── Acknowledgements: what Crew wears that others made ─────────────── */

const CREDITS: { what: string; who: string; license: string; href: string }[] = [
  { what: "Bot faces", who: "DiceBear", license: "CC0 1.0", href: "https://www.dicebear.com" },
  { what: "File icons", who: "Symbols by Miguel Solorio", license: "MIT", href: "https://github.com/miguelsolorio/vscode-symbols" },
];

function Credits({ onClose }: { onClose: () => void }) {
  return (
    <Overlay onClose={onClose} label="Acknowledgements" width="w-[380px]">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <h2 className="flex-1 text-[14px] font-semibold">Acknowledgements</h2>
        <IconButton icon={XIcon} label="Close" className="size-7" onClick={onClose} />
      </div>
      <ul className="mx-2 mb-2 flex flex-col">
        {CREDITS.map((credit) => (
          <li key={credit.what}>
            <button
              type="button"
              onClick={() => void openUrl(credit.href)}
              className="flex w-full text-left items-center gap-3 rounded-lg px-2.5 py-2 outline-none hover:bg-hover focus-visible:bg-hover"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-text-muted text-[12px]">{credit.what}</span>
                <span className="truncate">{credit.who}</span>
              </span>
              <span className="shrink-0 text-[12px] text-text-muted">{credit.license}</span>
              <ArrowUpRightIcon className="size-3.5 shrink-0 text-icon" />
            </button>
          </li>
        ))}
      </ul>
    </Overlay>
  );
}
