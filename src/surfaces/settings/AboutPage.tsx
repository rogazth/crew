// About: Crew's own page. Not reachable in the app: the update walks simulated
// phases and the build and changelog are fake (pending.ts), until S5 of
// docs/plans/2026-10-19-design-system-finish.md.
import { Collapsible } from "@base-ui/react/collapsible";
import {
  ArrowDownToLineIcon,
  ArrowUpRightIcon,
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  GlobeIcon,
  LoaderCircleIcon,
  RotateCwIcon,
  ScaleIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { CrewGlyph } from "../../chrome/CrewGlyph";
import { Button, IconButton, Overlay, Segmented, Switch } from "../../chrome/kit";
import { BUILD, CHANGELOG, RELEASE, setUpdate, useUpdateSim, wait, type ChangeKind } from "./pending";
import { Chip, CopyButton, Heading, ProgressBar, RAISED, SettingsPage, toast, type Tone } from "./ui";

const KIND: Record<ChangeKind, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "info" },
  improved: { label: "Improved", tone: "neutral" },
  fixed: { label: "Fixed", tone: "neutral" },
};

export function AboutPage() {
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const [credits, setCredits] = useState(false);
  return (
    <SettingsPage title="About" hideHeader>
      <Hero channel={channel} />
      <UpdateCard channel={channel} onChannel={setChannel} />
      <Build />
      <Changelog />
      <Links />
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

function Hero({ channel }: { channel: "stable" | "beta" }) {
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
      <div className="relative flex items-center gap-2 text-[12px] text-text-muted">
        <span className="tabular-nums">Version {RELEASE.current}</span>
        <span className="size-0.5 rounded-full bg-text-muted" />
        <Chip tone={channel === "beta" ? "warning" : "neutral"} dot={false}>
          {channel === "beta" ? "Beta" : "Stable"}
        </Chip>
        <span className="size-0.5 rounded-full bg-text-muted" />
        <span className="font-mono">{BUILD.find(([label]) => label === "Commit")?.[1]}</span>
      </div>
    </header>
  );
}

/* ── The update ─────────────────────────────────────────────────────── */

function UpdateCard({ channel, onChannel }: { channel: "stable" | "beta"; onChannel: (c: "stable" | "beta") => void }) {
  const { update, progress } = useUpdateSim();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState("2 minutes ago");
  const [auto, setAuto] = useState(true);

  const check = async () => {
    setChecking(true);
    await wait(1400);
    setChecking(false);
    setChecked("just now");
    // The simulated check always finds one, so the walk through the phases can start here.
    setUpdate("available");
  };

  let tile: ReactNode;
  let title: string;
  let line: string;
  let action: ReactNode;
  if (update === "available") {
    tile = <Tile tone="accent" icon={ArrowDownToLineIcon} />;
    title = `Crew ${RELEASE.version} available`;
    line = `${RELEASE.date} · ${RELEASE.size}`;
    action = (
      <Button variant="primary" icon={ArrowDownToLineIcon} onClick={() => setUpdate("downloading")}>
        Download
      </Button>
    );
  } else if (update === "downloading") {
    const mb = (48.2 * progress).toFixed(1);
    const left = Math.max(1, Math.round((1 - progress) * 24));
    tile = (
      <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-accent/12 text-accent">
        <LoaderCircleIcon className="size-5 animate-spin motion-reduce:animate-none" />
      </span>
    );
    title = `Downloading Crew ${RELEASE.version}`;
    line = `${mb} / 48.2 MB · ${left}s left`;
    action = (
      <Button variant="ghost" onClick={() => setUpdate("available")}>
        Cancel
      </Button>
    );
  } else if (update === "ready") {
    tile = <Tile tone="accent" icon={RotateCwIcon} solid />;
    title = `Crew ${RELEASE.version} is ready`;
    line = "Restart to install.";
    action = (
      <>
        <Button variant="ghost" onClick={() => toast("Updates on next quit", "info")}>
          Later
        </Button>
        <Button
          variant="primary"
          icon={RotateCwIcon}
          onClick={() => {
            setUpdate("none");
            toast(`Updated to ${RELEASE.version}`);
          }}
        >
          Restart
        </Button>
      </>
    );
  } else {
    tile = checking ? (
      <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-card text-icon">
        <LoaderCircleIcon className="size-5 animate-spin motion-reduce:animate-none" />
      </span>
    ) : (
      <Tile tone="success" icon={CheckIcon} />
    );
    title = checking ? "Checking…" : "Up to date";
    line = checking ? `${channel === "beta" ? "Beta" : "Stable"} channel` : `${RELEASE.current} · checked ${checked}`;
    action = (
      <Button icon={RotateCwIcon} loading={checking} onClick={() => void check()}>
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
          <p className="text-[12px] text-text-muted tabular-nums">{line}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{action}</div>
      </div>
      {update === "downloading" && (
        <div className="px-2.5 pb-2">
          <ProgressBar value={progress} />
        </div>
      )}
      {update !== "none" && (
        <ul className="flex flex-col gap-2 rounded-xl bg-card p-3.5">
          {RELEASE.notes.map((note) => (
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
      )}
      <div className="rounded-xl bg-card px-3.5 [&>*+*]:border-t [&>*+*]:border-hairline">
        <div data-setting="channel" className="flex min-h-11 items-center gap-6 py-2">
          <div className="min-w-0 flex-1">
            <p>Channel</p>
            <p className="text-[12px] text-text-muted">
              {channel === "beta"
                ? "Early builds, may be unstable."
                : "Tested releases."}
            </p>
          </div>
          <Segmented
            label="Update channel"
            value={channel}
            onChange={onChannel}
            options={[
              { value: "stable", label: "Stable" },
              { value: "beta", label: "Beta" },
            ]}
          />
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-6 py-2">
          <div className="min-w-0 flex-1">
            <p>Auto-download updates</p>
            <p className="text-[12px] text-text-muted">Asks before restarting.</p>
          </div>
          <Switch checked={auto} onChange={setAuto} />
        </label>
      </div>
    </section>
  );
}

function Tile({ tone, icon: Glyph, solid = false }: { tone: "accent" | "success"; icon: LucideIcon; solid?: boolean }) {
  const look = solid
    ? "bg-accent text-inverse shadow-[0_6px_16px_-6px_var(--color-accent)]"
    : tone === "success"
      ? "bg-success/12 text-success"
      : "bg-accent/12 text-accent";
  return (
    <span className={`grid size-10 shrink-0 place-items-center rounded-[12px] ${look}`}>
      <Glyph className="size-5" />
    </span>
  );
}

/* ── Build, changelog, links ────────────────────────────────────────── */

function Build() {
  const all = BUILD.map(([k, v]) => `${k}: ${v}`).join("\n");
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
      <dl className="grid grid-cols-1 gap-x-8 rounded-xl bg-card px-4 py-1.5 @[560px]:grid-cols-2">
        {BUILD.map(([k, v]) => (
          <div key={k} className="flex h-9 items-center justify-between gap-4 border-hairline [&:not(:nth-last-child(-n+2))]:border-b">
            <dt className="text-text-muted">{k}</dt>
            <dd className={`truncate tabular-nums ${k === "Commit" ? "font-mono text-[12px]" : ""}`} data-selectable>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Changelog() {
  // One release open at a time: opening another folds the last.
  const [open, setOpen] = useState<string | null>(CHANGELOG[0]?.version ?? null);
  return (
    <section data-setting="changelog" className="flex flex-col gap-2">
      <Heading
        title="What's new"
        action={
          <button
            type="button"
            onClick={() => toast("Opened release notes", "info")}
            className="text-[12px] text-link hover:underline"
          >
            All releases
          </button>
        }
      />
      <div className="rounded-xl bg-card px-1.5 py-1.5">
        {CHANGELOG.map((release, i) => (
          <Collapsible.Root
            key={release.version}
            open={open === release.version}
            onOpenChange={(next) => setOpen(next ? release.version : null)}
          >
            <Collapsible.Trigger className="group flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none hover:bg-hover focus-visible:bg-hover">
              <ChevronRightIcon className="size-3.5 shrink-0 text-icon transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none" />
              <span className="font-medium tabular-nums">{release.version}</span>
              {i === 0 && (
                <Chip tone="success" dot={false}>
                  Installed
                </Chip>
              )}
              <span className="ml-auto text-[12px] text-text-muted">{release.date}</span>
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
              <ul className="flex flex-col gap-2 pt-1 pr-3 pb-3 pl-8">
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
        ))}
      </div>
    </section>
  );
}

const LINKS: { icon: LucideIcon; label: string; line: string }[] = [
  { icon: GlobeIcon, label: "Website", line: "Guides and news" },
  { icon: CodeXmlIcon, label: "GitHub", line: "Source and releases" },
  { icon: BugIcon, label: "Report an issue", line: "Build info included" },
  { icon: ScaleIcon, label: "Licenses", line: "Open source notices" },
];

function Links() {
  return (
    <div className="grid grid-cols-2 gap-2 @[620px]:grid-cols-4">
      {LINKS.map(({ icon: Glyph, label, line }) => (
        <button
          key={label}
          type="button"
          onClick={() => toast(`Opened ${label}`, "info")}
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
            <a
              href={credit.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-lg px-2.5 py-2 outline-none hover:bg-hover focus-visible:bg-hover"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-text-muted text-[12px]">{credit.what}</span>
                <span className="truncate">{credit.who}</span>
              </span>
              <span className="shrink-0 text-[12px] text-text-muted">{credit.license}</span>
              <ArrowUpRightIcon className="size-3.5 shrink-0 text-icon" />
            </a>
          </li>
        ))}
      </ul>
    </Overlay>
  );
}
