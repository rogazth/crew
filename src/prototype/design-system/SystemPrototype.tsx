// PROTOTYPE — throwaway. The design system gallery, `?prototype=system`:
// every token and component of Crew on one page, under whichever direction
// the bar at the bottom picks (← → step through them). Run: `npm run prototype:system`.
// It never talks to crewd; the cards are the real components on fake blocks.
import {
  ArrowDownToLineIcon,
  BellIcon,
  CommandIcon,
  FolderGit2Icon,
  GlobeIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareTerminalIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { CrewGlyph } from "../../chrome/CrewGlyph";
import { Kbd } from "../../chrome/Kbd";
import { Button, FilterChip, IconButton, Segmented, Select, Switch, TextInput, Toggle } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { SettingsRow, SettingsSection } from "../../chrome/SettingsRow";
import { StatusDot } from "../../chrome/StatusDot";
import type { SessionStatus } from "../../lib/types";
import { WorkingLine } from "../../surfaces/chat/Activity";
import { CommandDot } from "../../surfaces/chat/Background";
import { QuestionCard } from "../../surfaces/chat/QuestionCard";
import { DirectionBar } from "./DirectionBar";
import { useProto } from "./direction";
import { OrchestrationGallery, ProcessesGallery } from "./work/WorkGallery";

const NOTES: Record<string, { title: string; line: string }> = {
  a: {
    title: "Ink",
    line: "Monochrome kept, refined: shadows instead of lines, soft signals, concentric radii, one activity glyph.",
  },
  b: {
    title: "Crew",
    line: "Ink's shape in the crew's colours: teal accent, warm-tinted greys.",
  },
  c: {
    title: "Cobalt",
    line: "Ink's shape with a blue accent, only for the one thing to do.",
  },
};

export function SystemPrototype() {
  const direction = useDirection();
  const note = NOTES[direction] ?? NOTES.a!;
  return (
    <div className="h-screen overflow-y-auto bg-canvas text-text">
      <div className="mx-auto flex max-w-5xl flex-col gap-16 px-10 pt-14 pb-32">
        <header className="flex items-start gap-4">
          <CrewGlyph className="size-12" />
          <div className="flex flex-col gap-1">
            <h1 className="text-[28px] leading-8 font-semibold tracking-[-0.025em]">Crew design system</h1>
            <p className="max-w-2xl text-[14px] leading-5 text-text-muted">
              <span className="font-medium text-text">{note.title}.</span> {note.line}
            </p>
          </div>
        </header>

        <Foundations />
        <Activity />
        <Controls />
        <ChatCards />
        <Section
          title="Orchestration"
          rule="Who got what, at a glance: one row per agent with its CLI, model and state. What waits on you is tinted. A row opens the thread."
        >
          <OrchestrationGallery />
        </Section>
        <Section
          title="Processes"
          rule="A command is a card, its runs are rows. Every state is a chip: green serving, amber starting, red crashed, an empty ring stopped."
        >
          <ProcessesGallery />
        </Section>
        <Updater />
        <Settings />
      </div>
      <DirectionBar keys />
    </div>
  );
}

function useDirection(): string {
  return useProto().direction;
}

/* ── Layout helpers ──────────────────────────────────────────────────── */

function Section({ title, rule, children }: { title: string; rule: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[18px] leading-6 font-semibold tracking-[-0.015em]">{title}</h2>
        <p className="max-w-2xl text-[13px] text-text-muted">{rule}</p>
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[11px] text-text-muted">{children}</span>;
}

/** A piece of the app's chrome, framed like the window it lives in. */
function Stage({ children, className = "", tint = false }: { children: ReactNode; className?: string; tint?: boolean }) {
  return (
    <div
      className={`rounded-float p-5 ring-1 ring-hairline ${tint ? "bg-sidebar" : "bg-canvas"} ${className}`}
    >
      {children}
    </div>
  );
}

/* ── Foundations ─────────────────────────────────────────────────────── */

const SURFACES = [
  ["sidebar", "Chrome ground: rail, sidebar, tabs"],
  ["canvas", "Where the work is"],
  ["surface", "Floating: menus, dialogs, cards"],
  ["fill", "A control's resting fill"],
] as const;

const INK = [
  ["text", "Text"],
  ["text-muted", "Secondary"],
  ["icon", "Icons"],
  ["placeholder", "Placeholder"],
] as const;

const SIGNALS = [
  ["accent", "Do this"],
  ["warning", "Wants you"],
  ["info", "Finished out of sight"],
  ["danger", "Failed"],
  ["success", "Went well"],
] as const;

function Foundations() {
  return (
    <>
      <Section
        title="Colour"
        rule="Three layers of ground, four inks, five signals. A signal is the only colour in the chrome, and each one means one thing."
      >
        <div className="grid grid-cols-[1fr_1fr] gap-6">
          <div className="flex flex-col gap-2">
            <Label>Ground, back to front</Label>
            <div className="flex flex-col overflow-hidden rounded-xl ring-1 ring-hairline">
              {SURFACES.map(([token, use]) => (
                <div key={token} className="flex h-12 items-center gap-3 px-4" style={{ background: `var(--color-${token})` }}>
                  <span className="font-medium">{token}</span>
                  <span className="text-[12px] text-text-muted">{use}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Ink</Label>
            <div className="flex flex-col gap-2.5 rounded-xl bg-canvas p-4 ring-1 ring-hairline">
              {INK.map(([token, use]) => (
                <div key={token} className="flex items-baseline gap-3">
                  <span className="w-36 shrink-0 text-[15px] font-medium" style={{ color: `var(--color-${token})` }}>
                    Aa {use}
                  </span>
                  <span className="text-[12px] text-text-muted">--color-{token}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Signals: solid when it is the action, soft when it is a state</Label>
          <div className="grid grid-cols-5 gap-3">
            {SIGNALS.map(([token, use]) => (
              <div key={token} className="flex flex-col gap-2">
                <div className="h-14 rounded-xl" style={{ background: `var(--color-${token})` }} />
                <span
                  className="inline-flex h-6 w-fit items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium"
                  style={{
                    background: `color-mix(in oklab, var(--color-${token}) 14%, transparent)`,
                    color: `var(--color-${token})`,
                  }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: `var(--color-${token})` }} />
                  {use}
                </span>
                <span className="text-[11px] text-text-muted">--color-{token}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Shape and depth"
        rule="Radius grows with size; an inner radius is the outer minus the padding. Depth is a shadow; a hairline is the only edge."
      >
        <div className="grid grid-cols-[1.2fr_1fr] gap-6">
          <div className="flex items-end gap-4">
            {(
              [
                ["md", "Controls", "size-12"],
                ["lg", "Rows, menus", "size-16"],
                ["chrome", "Tabs, sidebar", "size-16"],
                ["xl", "Cards", "size-20"],
                ["float", "Dialogs", "size-24"],
              ] as const
            ).map(([token, use, size]) => (
              <div key={token} className="flex flex-col items-center gap-2">
                <div className={`${size} bg-fill`} style={{ borderRadius: `var(--radius-${token})` }} />
                <span className="text-[12px] font-medium">{token}</span>
                <span className="text-[11px] text-text-muted">{use}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Label>Concentric: 18 outside, 12 padding, 6 inside</Label>
            <div className="rounded-[18px] bg-surface p-3 shadow-float">
              <div className="flex flex-col gap-1.5">
                <div className="rounded-[6px] bg-card px-3 py-2">Inner radius follows the outer one</div>
                <div className="rounded-[6px] bg-card px-3 py-2">So edges run parallel</div>
              </div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {(
            [
              ["Flat", "The canvas itself", "bg-canvas ring-1 ring-hairline"],
              ["Inset", "A fill: options, settings cards", "bg-card"],
              ["Raised", "Cards in the chat, the composer", "bg-surface ds-raised"],
              ["Floating", "Menus, palette, dialogs", "bg-surface shadow-float"],
            ] as const
          ).map(([name, use, cls]) => (
            <div key={name} className={`flex h-24 flex-col justify-end gap-0.5 rounded-xl p-3 ${cls}`}>
              <span className="font-medium">{name}</span>
              <span className="text-[12px] text-text-muted">{use}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Type"
        rule="The system face, at a dense 13px for the chrome and 14px for what an agent wrote. Weight carries hierarchy before size does."
      >
        <div className="flex flex-col divide-y divide-hairline rounded-xl ring-1 ring-hairline">
          {(
            [
              ["Page title", "text-[22px] leading-7 font-semibold tracking-[-0.02em]", "Settings"],
              ["Section", "text-[15px] leading-5 font-semibold tracking-[-0.01em]", "Sessions"],
              ["Chat", "text-[14px] leading-[21px]", "The change is small and tested. One decision is yours before I approve."],
              ["Chrome", "text-[13px]", "Delete inactive sessions"],
              ["Secondary", "text-[12px] text-text-muted", "Sessions untouched this long are deleted."],
              ["Caption", "text-[11px] text-text-muted", "Today 11:31 PM"],
              ["Code", "font-mono text-[12.5px]", "git diff main -- src/lib/keymap.ts"],
            ] as const
          ).map(([role, cls, sample]) => (
            <div key={role} className="flex items-baseline gap-6 px-4 py-3">
              <span className="w-24 shrink-0 text-[11px] text-text-muted">{role}</span>
              <span className={cls}>{sample}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Motion"
        rule="Motion answers a hand. 120ms for colour, a spring for things that move. Only running work moves on its own."
      >
        <div className="flex items-center gap-3">
          <Button variant="primary">Press me</Button>
          <Button>Or me</Button>
          <span className="text-[12px] text-text-muted">Buttons give a little under the finger.</span>
        </div>
      </Section>
    </>
  );
}

/* ── Activity ────────────────────────────────────────────────────────── */

const STATES: { status: SessionStatus; means: string }[] = [
  { status: "working", means: "A turn is running. The only fast motion." },
  { status: "background", means: "Turn ended, work runs on. Same arc, slow." },
  { status: "needs-input", means: "Waiting on you. Amber, with a halo." },
  { status: "error", means: "It failed. Red, with a halo." },
  { status: "done", means: "Finished while away. Blue dot until read." },
  { status: "idle", means: "Nothing drawn." },
];

function Activity() {
  const [since] = useState(() => Date.now() - 74_000);
  return (
    <Section
      title="Activity"
      rule="One arc for everything that runs: fast and in ink for a turn, slow and grey in the background."
    >
      <div className="grid grid-cols-[1fr_1.1fr] gap-6">
        <div className="flex flex-col divide-y divide-hairline rounded-xl ring-1 ring-hairline">
          {STATES.map(({ status, means }) => (
            <div key={status} className="flex items-center gap-3 px-4 py-2.5">
              <span className="grid size-4 shrink-0 place-items-center">
                <StatusDot status={status} />
              </span>
              <span className="w-28 shrink-0 font-medium">{status}</span>
              <span className="text-[12px] text-text-muted">{means}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-4">
          <Stage tint className="flex flex-col gap-1 p-2!">
            <SessionRow provider="claude" name="Planner" detail="Working · 1m 14s" status="working" />
            <SessionRow provider="codex" name="Release notes" detail="2 in background" status="background" />
            <SessionRow provider="claude" name="Reviewer" detail="Asked you a question" status="needs-input" />
            <SessionRow provider="opencode" name="Docs sweep" detail="Finished 4m ago" status="done" />
          </Stage>
          <Stage className="flex flex-col gap-3">
            <WorkingLine since={since} waiting={false} />
            <div className="flex min-h-6 items-center gap-2 text-[13px] leading-[18px] text-text-muted">
              <span className="crew-node">
                <span className="crew-bg-dot" />
              </span>
              <span>Running in background · npm run dev, 1 subagent</span>
            </div>
            <div className="flex items-center gap-2 text-[12px] text-text-muted">
              <CommandDot command={{ state: "running" } as never} />
              <span className="font-mono">npm run dev</span>
              <span className="ml-auto">a command in its panel</span>
            </div>
          </Stage>
          <Stage tint className="flex items-center gap-1.5 p-2!">
            <TabPill name="Planner" status="working" active />
            <TabPill name="Release" status="background" />
            <TabPill name="Reviewer" status="needs-input" warn />
          </Stage>
        </div>
      </div>
    </Section>
  );
}

function SessionRow({ provider, name, detail, status }: { provider: string; name: string; detail: string; status: SessionStatus }) {
  return (
    <div className="flex h-9 items-center gap-2.5 rounded-chrome px-2.5 hover:bg-hover">
      <ProviderIcon provider={provider} className="size-4" />
      <span className="font-medium">{name}</span>
      <span className="truncate text-[12px] text-text-muted">{detail}</span>
      <span className="ml-auto">
        <StatusDot status={status} />
      </span>
    </div>
  );
}

function TabPill({ name, status, active = false, warn = false }: { name: string; status: SessionStatus; active?: boolean; warn?: boolean }) {
  return (
    <div
      className={`flex h-7 min-w-[130px] items-center gap-2 rounded-chrome pr-1.5 pl-2.5 ring-1 ${
        warn
          ? "bg-warning/12 ring-warning/30"
          : active
            ? "bg-canvas ring-hairline shadow-[0_1px_2px_var(--color-hairline)]"
            : "bg-card text-text-muted ring-transparent"
      }`}
    >
      <span className="flex-1 truncate">{name}</span>
      <StatusDot status={status} className="size-3" />
    </div>
  );
}

/* ── Controls ────────────────────────────────────────────────────────── */

function Controls() {
  const [on, setOn] = useState(true);
  const [mode, setMode] = useState<"system" | "light" | "dark">("system");
  const [when, setWhen] = useState<"never" | "7d" | "30d">("never");
  const [filter, setFilter] = useState<"all" | "mine">("all");
  return (
    <Section
      title="Controls"
      rule="One primary per surface, and it is the action the surface exists for. Secondary is a fill, ghost is for the many small things, danger only ever deletes."
    >
      <Stage className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="primary" keys="⌘⏎">
            Update and restart
          </Button>
          <Button>Later</Button>
          <Button variant="ghost" icon={PlusIcon}>
            New session
          </Button>
          <Button variant="danger" icon={TrashIcon}>
            Delete worktree
          </Button>
          <Button loading>Installing</Button>
          <Button disabled>Disabled</Button>
          <IconButton icon={SearchIcon} label="Search" />
          <IconButton icon={SettingsIcon} label="Settings" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Text field</Label>
            <TextInput placeholder="Name this worktree" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Select</Label>
            <Select
              label="Delete inactive sessions"
              value={when}
              onChange={setWhen}
              className="w-full"
              options={[
                { value: "never", label: "Never" },
                { value: "7d", label: "After 7 days" },
                { value: "30d", label: "After 30 days" },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Segmented</Label>
            <Segmented
              label="Appearance"
              value={mode}
              onChange={setMode}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2.5">
            <Switch checked={on} onChange={setOn} label="Notify" />
            <span>Switch</span>
          </div>
          <FilterChip
            label="Sessions"
            value={filter}
            neutral="all"
            onChange={setFilter}
            options={[
              { value: "all", label: "All sessions" },
              { value: "mine", label: "Started by me" },
            ]}
          />
          <span className="flex items-center gap-1.5 text-text-muted">
            <Kbd keys="⌘" />
            <Kbd keys="K" /> keys
          </span>
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-card px-2.5 text-[12px]">
            <FolderGit2Icon className="size-3.5 text-icon" />
            feat/tab-indicators
          </span>
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-info/12 px-2.5 text-[12px] font-medium text-info">
            <SparklesIcon className="size-3.5" />
            Fast
          </span>
        </div>
      </Stage>
    </Section>
  );
}

/* ── Chat cards ──────────────────────────────────────────────────────── */

function ChatCards() {
  const [key, setKey] = useState(0);
  return (
    <Section
      title="Cards in the chat"
      rule="A card is one raised surface. Options are fills, never outlines; the picked one takes the accent."
    >
      <div className="mx-auto w-full max-w-[720px]">
        <QuestionCard
          key={key}
          block={{
            id: "q",
            role: "question",
            text: "",
            question: {
              requestId: 1,
              questions: [
                {
                  header: "Keys",
                  question: "When a key matches one command by its character and another by its physical key, which one wins?",
                  multiSelect: false,
                  options: [
                    { label: "The character", description: "⌘- is zoom out on every layout." },
                    { label: "The physical key", description: "⌘/ stays where US keyboards have it." },
                  ],
                },
                {
                  header: "Layouts",
                  question: "Which layouts should the e2e suite cover?",
                  multiSelect: true,
                  options: [{ label: "US" }, { label: "German" }, { label: "French AZERTY" }],
                },
              ],
            },
          }}
          onAnswer={() => setKey((k) => k + 1)}
        />
      </div>
    </Section>
  );
}

/* ── Updater ─────────────────────────────────────────────────────────── */

function Updater() {
  return (
    <Section
      title="Updates"
      rule="An update is news, not an interruption: a pill at the sidebar's foot that asks for a click only when ready. Checks are toasts."
    >
      <div className="grid grid-cols-[1fr_1.15fr] gap-6">
        <Stage tint className="flex flex-col gap-4">
          <Label>The pill, through its states</Label>
          <UpdatePill phase="available" />
          <UpdatePill phase="downloading" />
          <UpdatePill phase="ready" />
          <div className="mt-2 flex flex-col gap-2">
            <Label>Toasts</Label>
            <Toast icon={<RotateCwIcon className="size-4 animate-spin text-icon" />} text="Checking for updates…" />
            <Toast icon={<span className="size-2 rounded-full bg-success" />} text="Crew is up to date" />
          </div>
        </Stage>

        <div className="flex flex-col gap-2">
          <Label>Release notes</Label>
          <div className="flex flex-col overflow-hidden rounded-float bg-surface shadow-float">
            <div className="flex items-start gap-3 p-4 pb-3">
              <CrewGlyph className="size-9" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold tracking-[-0.01em]">Crew 0.3.16</span>
                <span className="text-[12px] text-text-muted">You are on 0.3.15 · 48.6 MB</span>
              </div>
              <IconButton icon={XIcon} label="Close" className="size-7" />
            </div>
            <ul className="mx-4 flex flex-col gap-2 rounded-xl bg-card p-3 text-[13px]">
              <li className="flex gap-2">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" />
                Big attachments upload to remote machines in pieces, with progress.
              </li>
              <li className="flex gap-2">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" />A nameless shell shows its command as the row's
                preview.
              </li>
              <li className="flex gap-2">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-text-muted" />
                Background subagents no longer leave a stray wake note.
              </li>
            </ul>
            <div className="flex items-center gap-2 p-4">
              <span className="text-[12px] text-text-muted">Reopens where you left off.</span>
              <span className="flex-1" />
              <Button variant="ghost">Later</Button>
              <Button variant="primary" keys="⌘⏎">
                Restart to update
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function UpdatePill({ phase }: { phase: "available" | "downloading" | "ready" }) {
  if (phase === "ready")
    return (
      <button
        type="button"
        className="flex h-9 w-60 items-center gap-2.5 rounded-full bg-accent pr-3 pl-1.5 text-inverse shadow-[0_6px_16px_-6px_var(--color-accent)]"
      >
        <span className="grid size-6 place-items-center rounded-full bg-white/20">
          <RotateCwIcon className="size-3.5" />
        </span>
        <span className="font-medium">Restart to update</span>
        <span className="ml-auto text-[12px] opacity-75">0.3.16</span>
      </button>
    );
  if (phase === "downloading")
    return (
      <div className="flex h-9 w-60 items-center gap-2.5 rounded-full bg-canvas pr-3 pl-1.5 ring-1 ring-hairline">
        <ProgressRing value={0.42} />
        <span>Downloading 0.3.16</span>
        <span className="ml-auto text-[12px] text-text-muted tabular-nums">42%</span>
      </div>
    );
  return (
    <button type="button" className="flex h-9 w-60 items-center gap-2.5 rounded-full bg-canvas pr-3 pl-1.5 ring-1 ring-hairline hover:bg-hover">
      <span className="grid size-6 place-items-center rounded-full bg-accent/14 text-accent">
        <ArrowDownToLineIcon className="size-3.5" />
      </span>
      <span>Crew 0.3.16 is out</span>
      <span className="ml-auto size-2 rounded-full bg-accent" />
    </button>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 24 24" className="size-6 -rotate-90" aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2.5" className="stroke-selected" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        className="stroke-accent"
      />
    </svg>
  );
}

function Toast({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex h-10 w-fit items-center gap-2.5 rounded-xl bg-surface px-3.5 shadow-float">
      {icon}
      <span>{text}</span>
    </div>
  );
}

/* ── Settings ────────────────────────────────────────────────────────── */

const SETTINGS_NAV = [
  [SlidersHorizontalIcon, "General"],
  [PaletteIcon, "Appearance"],
  [BellIcon, "Notifications"],
  [SquareTerminalIcon, "Terminal"],
  [GlobeIcon, "Browser"],
  [ServerIcon, "Environments"],
  [CommandIcon, "Providers"],
  [KeyboardIcon, "Keybindings"],
  [InfoIcon, "About"],
] as const;

function Settings() {
  const [bypass, setBypass] = useState(false);
  const [notify, setNotify] = useState(true);
  const [tabs, setTabs] = useState<"worktree" | "together">("worktree");
  const [when, setWhen] = useState<"never" | "7d" | "30d">("never");
  return (
    <Section
      title="Settings"
      rule="One line under each title. Rows are a label, short help and a control on the right. Destructive actions sit in their own card at the foot."
    >
      <div className="flex h-[620px] overflow-hidden rounded-float ring-1 ring-hairline">
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 bg-sidebar p-2.5">
          <div className="mb-2 flex h-8 items-center gap-2 rounded-lg bg-fill px-2.5 text-placeholder">
            <SearchIcon className="size-3.5" />
            Search settings
          </div>
          {SETTINGS_NAV.map(([Glyph, name], i) => (
            <div
              key={name}
              className={`flex h-8 items-center gap-2.5 rounded-chrome px-2.5 ${i === 0 ? "bg-selected font-medium" : "text-text hover:bg-hover"}`}
            >
              <Glyph className={`size-4 ${i === 0 ? "" : "text-icon"}`} />
              {name}
            </div>
          ))}
          <span className="flex-1" />
          <UpdatePill phase="available" />
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto bg-canvas">
          <div className="mx-auto flex max-w-2xl flex-col gap-7 px-10 py-10">
            <header className="flex flex-col gap-1 px-1">
              <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">General</h1>
              <p className="text-text-muted">Worktrees, sessions and the crew command.</p>
            </header>
            <SettingsSection title="Worktrees">
              <SettingsRow label="Tabs" description="Tabs per worktree, or one strip for all.">
                <Segmented
                  label="Tabs"
                  value={tabs}
                  onChange={setTabs}
                  options={[
                    { value: "worktree", label: "Per worktree" },
                    { value: "together", label: "Together" },
                  ]}
                />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="Sessions">
              <SettingsRow label="Delete inactive sessions" description="Working, unread and scheduled sessions are kept.">
                <Select
                  label="Delete inactive sessions"
                  value={when}
                  onChange={setWhen}
                  className="w-40"
                  options={[
                    { value: "never", label: "Never" },
                    { value: "7d", label: "After 7 days" },
                    { value: "30d", label: "After 30 days" },
                  ]}
                />
              </SettingsRow>
              <Toggle
                checked={notify}
                onChange={setNotify}
                label="Notify when a session needs you"
                description="A banner, plus any sound you set."
              />
            </SettingsSection>
            <SettingsSection title="Command line">
              <SettingsRow label="crew command" description="Use crew from your terminal. Links into ~/.local/bin.">
                <Button>Install</Button>
              </SettingsRow>
            </SettingsSection>
            <section className="flex flex-col gap-2">
              <h2 className="px-2.5 text-[12px] font-medium text-text-muted">Careful</h2>
              <div className="rounded-xl bg-danger/6 px-4 ring-1 ring-danger/15">
                <Toggle
                  checked={bypass}
                  onChange={setBypass}
                  label="Bypass permissions"
                  description="All sessions run tools without asking."
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </Section>
  );
}
