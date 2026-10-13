/* eslint-disable react-hooks/refs, react-refresh/only-export-components -- PROTOTYPE, throwaway */
// PROTOTYPE — throwaway. Four takes on the chat redesign of
// docs/plans/2026-10-07-chat-over-protocol.md, decisions 28–36:
//   A  Tray       — today's layout grown up: queue and background above the composer.
//   B  Side panel — a running-work panel beside the chat, like Claude Code's agents view.
//   C  Status line — everything folds into one line under the composer; sheets on demand.
//   D  Fast gallery — five ways to show fast mode, in every state.
import {
  ArchiveIcon,
  ArrowDownIcon,
  BotIcon,
  CircleStopIcon,
  EyeIcon,
  FileTextIcon,
  HandIcon,
  MessagesSquareIcon,
  SendIcon,
  SparklesIcon,
  TerminalIcon,
  UsersIcon,
  ArrowUpIcon,
  BrainIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
  GaugeIcon,
  ListOrderedIcon,
  LockIcon,
  PanelRightIcon,
  PaperclipIcon,
  PencilIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Kbd } from "../../chrome/Kbd";
import { Button } from "../../chrome/kit";

const Markdown = lazy(() => import("../../surfaces/chat/Markdown").then((m) => ({ default: m.Markdown })));
import {
  CHIP,
  ContextBar,
  ContextHover,
  ContextRing,
  ContextTitle,
  EntryMark,
  FastChip,
  FastSegmented,
  KindIcon,
  Mark,
  ModelFastChip,
  Section,
  StateDot,
  Thread,
  contextShare,
  fastHidden,
  stateWord,
} from "./parts";
import { KIND_LABEL, MODEL, elapsed, tokens, type Entry, type Fast, type Provider, type Queued, type Sim } from "./sim";

/** Anything a composer can send to: the session, or a Crew subagent. */
type Target = { send: (text: string, wait?: boolean) => void; stop: () => void; working: boolean; canSteer: boolean };

const placeholder = (sim: Target) =>
  !sim.working
    ? "Ask anything — @ to mention a file"
    : sim.canSteer
      ? "Working — ↵ adds this to the running turn, esc stops"
      : "Working — ↵ queues this for the next turn, esc stops";

/** Enter sends, steers or queues — never stops. Esc stops the turn. */
function useDraft(sim: Target, escStops = true) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);
  const submit = (wait = false) => {
    if (!draft.trim()) return;
    sim.send(draft, wait);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (escStops && event.key === "Escape" && sim.working) {
      event.preventDefault();
      sim.stop();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // ⌘↵ while it works: wait for the turn instead of joining it.
    submit(event.metaKey);
  };
  return { draft, setDraft, field, submit, onKeyDown };
}

function Field({ sim, d, hint }: { sim: Target; d: ReturnType<typeof useDraft>; hint?: string }) {
  return (
    <textarea
      ref={d.field}
      rows={1}
      value={d.draft}
      placeholder={hint ?? placeholder(sim)}
      spellCheck={false}
      onChange={(e) => d.setDraft(e.target.value)}
      onKeyDown={d.onKeyDown}
      className="crew-composer-field crew-composer-input"
    />
  );
}

/** Send and stop are two buttons: the one that sends never stops. */
function SendStop({ sim, d }: { sim: Target; d: ReturnType<typeof useDraft> }) {
  const can = d.draft.trim().length > 0;
  return (
    <>
      {sim.working && (
        <button
          type="button"
          onClick={sim.stop}
          title="Stop the turn (esc)"
          className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-text-muted ring-1 ring-hairline transition-colors hover:bg-hover hover:text-text"
        >
          <SquareIcon className="size-2.5 fill-current" />
          Stop
        </button>
      )}
      <button
        type="button"
        disabled={!can}
        onClick={() => d.submit()}
        aria-label={sim.working ? (sim.canSteer ? "Add to the running turn" : "Queue for the next turn") : "Send"}
        title={sim.working ? (sim.canSteer ? "Add to the running turn" : "Queue for the next turn") : "Send"}
        className={`flex size-[30px] shrink-0 items-center justify-center rounded-full transition-colors ${
          can ? "crew-ink hover:bg-accent-hover" : "bg-card text-text-muted"
        }`}
      >
        {sim.working && !sim.canSteer ? <ListOrderedIcon className="size-4" /> : <ArrowUpIcon className="size-4" />}
      </button>
    </>
  );
}

function Chips({ sim, fast }: { sim: Sim; fast: ReactNode }) {
  return (
    <>
      <button type="button" aria-label="Attach files" className="crew-composer-plus shrink-0">
        <PaperclipIcon className="size-4" />
      </button>
      <span className={CHIP}>
        <Mark provider={sim.provider} className="size-3.5" />
        {sim.model}
        <ChevronDownIcon className="size-3 text-icon" />
      </span>
      <span className={CHIP}>
        <BrainIcon className="size-3.5 text-icon" />
        High
        <ChevronDownIcon className="size-3 text-icon" />
      </span>
      {fast}
    </>
  );
}

/** One queued message: what it is, when it lands, and what can be done with it. */
function QueuedRow({ sim, q, index }: { sim: Sim; q: Queued; index: number }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(q.text);
  const when =
    q.mode === "steer"
      ? "at its next step"
      : sim.paused
        ? "held — you stopped the turn"
        : sim.working
          ? "after this turn"
          : "next";
  return (
    <div className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-[10.5px] text-text-muted tabular-nums">{index + 1}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {editing ? (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              sim.editQueued(q.id, text);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full rounded bg-canvas px-1.5 py-0.5 text-[13px] ring-1 ring-border outline-none"
          />
        ) : (
          <span className="truncate text-[13px]">{q.text}</span>
        )}
        <span className="text-[11px] text-text-muted">
          <button
            type="button"
            disabled={!sim.canSteer}
            onClick={() => sim.flipQueued(q.id)}
            title={sim.canSteer ? "⌘↵ flips between adding to the turn and waiting for it" : `${sim.provider} can't take a message mid-turn`}
            className="rounded px-1 py-px ring-1 ring-hairline enabled:hover:bg-selected disabled:opacity-60"
          >
            {q.mode === "steer" ? "Into this turn" : "Next turn"}
          </button>{" "}
          {when}
        </span>
      </div>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton title="Move up" onClick={() => sim.moveQueued(q.id, -1)}>
          <ArrowUpIcon className="size-3.5" />
        </IconButton>
        <IconButton title="Move down" onClick={() => sim.moveQueued(q.id, 1)}>
          <ArrowDownIcon className="size-3.5" />
        </IconButton>
        <IconButton title="Edit" onClick={() => setEditing(true)}>
          <PencilIcon className="size-3.5" />
        </IconButton>
        <IconButton title="Delete" onClick={() => sim.removeQueued(q.id)}>
          <Trash2Icon className="size-3.5" />
        </IconButton>
        <button
          type="button"
          onClick={() => sim.sendNow(q.id)}
          title="Stops the turn and sends this now"
          className="ml-1 flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-text-muted ring-1 ring-hairline hover:bg-selected hover:text-text"
        >
          <CornerDownLeftIcon className="size-3" />
          Send now
        </button>
      </span>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className="grid size-6 place-items-center rounded-md text-text-muted hover:bg-selected hover:text-text">
      {children}
    </button>
  );
}

function StopEntry({ entry, onStop }: { entry: Entry; onStop: () => void }) {
  if (entry.state !== "running") return null;
  if (entry.stoppable !== true)
    return (
      <span title={entry.stoppable} className="flex h-6 shrink-0 items-center rounded-md px-1.5 text-[11.5px] text-placeholder">
        can't stop alone
      </span>
    );
  return (
    <button
      type="button"
      title="Stop (x)"
      onClick={(e) => {
        e.stopPropagation();
        onStop();
      }}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-text-muted hover:bg-selected hover:text-text"
    >
      <XIcon className="size-3" />
      Stop
    </button>
  );
}

/** One entry's live output, in the reading column over the transcript. */
function OutputOverlay({ sim, entry, onClose }: { sim: Sim; entry: Entry; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entry.lines.length]);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "x" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) sim.stopEntry(entry.id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [entry.id, onClose, sim]);
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-canvas">
      <div className="flex justify-center px-6 pt-3 pb-2">
        <div className="flex h-10 max-w-full items-center gap-1 rounded-full bg-surface px-1.5 shadow-float">
          <span className="flex h-7 min-w-0 items-center gap-2 px-2 text-[13px]">
            <EntryMark entry={entry} />
            <span className="truncate">{entry.title}</span>
          </span>
          <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 text-[12px] text-text-muted tabular-nums">
            <StateDot state={entry.state} />
            {stateWord(entry)} · {elapsed(entry.startedAt, entry.endedAt ?? sim.now)}
          </span>
          <StopEntry entry={entry} onStop={() => sim.stopEntry(entry.id)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pb-24">
          <p className="mb-2 px-1 text-[12px] text-text-muted">
            {KIND_LABEL[entry.kind]} · {entry.detail}
            {entry.model ? ` · ${entry.model}` : ""}
          </p>
          <pre className="rounded-xl border border-border bg-sidebar px-4 py-3 font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap">
            {entry.lines.join("\n") || "No output yet."}
          </pre>
          <div ref={end} />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-4 flex justify-center">
        <button type="button" onClick={onClose} className="flex h-9 items-center gap-2 rounded-full bg-surface pr-2.5 pl-4 text-[13px] shadow-float hover:bg-hover">
          Back to the chat
          <Kbd keys="esc" />
        </button>
      </div>
    </div>
  );
}

function summary(entries: Entry[]) {
  const running = entries.filter((e) => e.state === "running");
  const by = (k: Entry["kind"]) => running.filter((e) => e.kind === k).length;
  const agents = by("agent") + by("crew");
  const parts = [agents && `${agents} agent${agents > 1 ? "s" : ""}`, by("shell") && `${by("shell")} shell${by("shell") > 1 ? "s" : ""}`, by("process") && `${by("process")} process`].filter(Boolean);
  const done = entries.length - running.length;
  return `${parts.join(" · ") || "nothing running"}${done ? ` · ${done} finished` : ""}`;
}

// ───────────────────────────── A · Tray ─────────────────────────────

export function VariantA({ sim }: { sim: Sim }) {
  const d = useDraft(sim);
  const [open, setOpen] = useState<string | null>(null);
  const [trayOpen, setTrayOpen] = useState(true);
  const entry = sim.entries.find((e) => e.id === open);
  const groups: [string, Entry["kind"][]][] = [
    ["Agents", ["agent", "crew"]],
    ["Shells", ["shell"]],
    ["Processes", ["process"]],
  ];
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Thread items={sim.items} working={sim.working} onOpenEntry={setOpen} />
      </div>
      <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2">
        <div className="rounded-2xl bg-card">
          <button type="button" onClick={() => setTrayOpen((o) => !o)} className="flex h-9 w-full items-center gap-2 px-3.5 text-left text-[12.5px]">
            <span className="text-text">Background</span>
            <span className="text-text-muted">· {summary(sim.entries)}</span>
            <span className="flex-1" />
            {sim.entries.some((e) => e.state !== "running") && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  sim.clearFinished();
                }}
                className="rounded px-1.5 text-[11.5px] text-text-muted hover:bg-selected hover:text-text"
              >
                Clear finished
              </span>
            )}
            <ChevronDownIcon className={`size-3.5 text-icon transition-transform ${trayOpen ? "rotate-180" : ""}`} />
          </button>
          {trayOpen && (
            <div className="flex max-h-[26vh] flex-col overflow-y-auto px-1.5 pb-1.5">
              {groups.map(([title, kinds]) => {
                const rows = sim.entries.filter((e) => kinds.includes(e.kind));
                if (rows.length === 0) return null;
                return (
                  <Section key={title} title={title}>
                    {rows.map((e) => (
                      <div
                        key={e.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setOpen(e.id)}
                        className="flex h-8 items-center gap-2.5 rounded-lg px-2 hover:bg-hover"
                      >
                        <span className="grid size-3.5 place-items-center">
                          <StateDot state={e.state} />
                        </span>
                        <EntryMark entry={e} />
                        <span className={`min-w-0 truncate text-[12.5px] ${e.state === "running" ? "" : "text-text-muted"}`}>{e.title}</span>
                        {e.kind === "crew" && <span className="shrink-0 rounded bg-card px-1 text-[10.5px] text-text-muted">crew</span>}
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-placeholder">{e.lines.at(-1)}</span>
                        <span className="shrink-0 text-[11.5px] text-text-muted tabular-nums">
                          {stateWord(e)} {elapsed(e.startedAt, e.endedAt ?? sim.now)}
                        </span>
                        <StopEntry entry={e} onStop={() => sim.stopEntry(e.id)} />
                      </div>
                    ))}
                  </Section>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {sim.queue.length > 0 && (
        <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2">
          <div className="rounded-2xl ring-1 ring-hairline">
            <div className="flex h-8 items-center gap-2 px-3.5 text-[12px] text-text-muted">
              <ListOrderedIcon className="size-3.5" />
              {sim.queue.length} waiting
              {sim.paused && (
                <button type="button" onClick={sim.resume} className="ml-auto rounded px-1.5 hover:bg-hover hover:text-text">
                  Send them
                </button>
              )}
            </div>
            <div className="px-1.5 pb-1.5">
              {sim.queue.map((q, i) => (
                <QueuedRow key={q.id} sim={sim} q={q} index={i} />
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-3">
        <div className="crew-composer relative">
          <Field sim={sim} d={d} />
          <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Chips sim={sim} fast={<FastSegmented fast={sim.fast} onToggle={sim.toggleFast} />} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <ContextRing sim={sim} />
              <span className={CHIP}>
                <LockIcon className="size-3.5 text-icon" />
                Ask
              </span>
              <SendStop sim={sim} d={d} />
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-placeholder">
          ↵ {sim.working ? (sim.canSteer ? "add to the turn" : "queue") : "send"} · ⌘↵ {sim.working ? "next turn" : "send"} · esc stop · ⇧↵ new line
        </p>
      </div>
      {entry && <OutputOverlay sim={sim} entry={entry} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ───────────────────────────── B · Side panel ─────────────────────────────

export function VariantB({ sim }: { sim: Sim }) {
  const d = useDraft(sim);
  const [panel, setPanel] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const list = [...sim.entries].sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt);
  const current = sim.entries.find((e) => e.id === selected) ?? list[0];
  const running = sim.entries.filter((e) => e.state === "running").length;

  useEffect(() => {
    if (!panel) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      const index = list.findIndex((x) => x.id === current?.id);
      if (e.key === "ArrowDown") setSelected(list[Math.min(list.length - 1, index + 1)]?.id ?? null);
      if (e.key === "ArrowUp") setSelected(list[Math.max(0, index - 1)]?.id ?? null);
      if (e.key === "x" && current) sim.stopEntry(current.id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [panel, list, current, sim]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [current?.lines.length]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center justify-end px-3">
          <button type="button" onClick={() => setPanel((p) => !p)} className={`${CHIP} ${panel ? "bg-selected" : ""}`}>
            <PanelRightIcon className="size-3.5 text-icon" />
            Running
            {running > 0 && <span className="rounded-full bg-text px-1.5 text-[10.5px] text-canvas tabular-nums">{running}</span>}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Thread items={sim.items} working={sim.working} onOpenEntry={(id) => (setPanel(true), setSelected(id))} />
          {sim.queue.length > 0 && (
            <div className="mx-auto flex w-full max-w-[760px] flex-col items-end gap-2 px-6 pb-6">
              {sim.queue.map((q) => (
                <div key={q.id} className="group flex max-w-[80%] flex-col items-end gap-1">
                  <div className="rounded-2xl border border-dashed border-border-strong px-3.5 py-2 text-[14px] text-text-muted">{q.text}</div>
                  <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                    {q.mode === "steer" ? "Read at its next step" : sim.paused ? "Held — you stopped the turn" : `Next turn${sim.canSteer ? "" : ` · ${sim.provider} can't steer`}`}
                    <span className="hidden items-center gap-0.5 group-hover:flex">
                      {sim.canSteer && (
                        <button type="button" onClick={() => sim.flipQueued(q.id)} className="rounded px-1 ring-1 ring-hairline hover:bg-hover">
                          {q.mode === "steer" ? "wait instead" : "into this turn"}
                        </button>
                      )}
                      <button type="button" onClick={() => sim.sendNow(q.id)} className="rounded px-1 ring-1 ring-hairline hover:bg-hover">
                        send now
                      </button>
                      <button type="button" onClick={() => sim.removeQueued(q.id)} className="rounded px-1 ring-1 ring-hairline hover:bg-hover">
                        delete
                      </button>
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-3">
          <div className="crew-composer relative overflow-hidden">
            <div className="absolute inset-x-4 top-0">
              <ContextBar sim={sim} />
            </div>
            <Field sim={sim} d={d} />
            <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <button type="button" aria-label="Attach files" className="crew-composer-plus shrink-0">
                  <PaperclipIcon className="size-4" />
                </button>
                <ModelFastChip model={sim.model} fast={sim.fast} onToggle={sim.toggleFast} />
                <span className={CHIP}>
                  <BrainIcon className="size-3.5 text-icon" />
                  High
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-[11.5px] text-text-muted tabular-nums" title={ContextTitle(sim)}>
                  {tokens(sim.context.used)} / {tokens(sim.context.window)}
                </span>
                <SendStop sim={sim} d={d} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {panel && (
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-sidebar">
          <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-[12.5px]">
            <span className="font-medium">Running</span>
            <span className="text-text-muted">{summary(sim.entries)}</span>
            <span className="flex-1" />
            <button type="button" onClick={sim.clearFinished} className="rounded px-1.5 text-[11.5px] text-text-muted hover:bg-hover hover:text-text">
              Clear finished
            </button>
          </div>
          <div className="flex max-h-[45%] flex-col overflow-y-auto px-1.5">
            <div className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px]">
              <span className="grid size-3.5 place-items-center">{sim.working ? <span className="crew-bg-dot" /> : <span className="size-1.5 rounded-full bg-text-muted" />}</span>
              <Mark provider={sim.provider} className="size-3.5" />
              <span className="truncate">This session</span>
              <span className="text-[11.5px] text-text-muted">{sim.working ? "working" : "idle"}</span>
            </div>
            {list.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelected(e.id)}
                className={`flex h-8 items-center gap-2 rounded-lg pr-2 pl-6 text-left text-[12.5px] ${current?.id === e.id ? "bg-selected" : "hover:bg-hover"}`}
              >
                <span className="grid size-3.5 place-items-center">
                  <StateDot state={e.state} />
                </span>
                <EntryMark entry={e} />
                <span className={`min-w-0 flex-1 truncate ${e.state === "running" ? "" : "text-text-muted"}`}>{e.title}</span>
                <span className="shrink-0 text-[11px] text-text-muted tabular-nums">{elapsed(e.startedAt, e.endedAt ?? sim.now)}</span>
              </button>
            ))}
          </div>
          {current && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-border">
              <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-[12px]">
                <KindIcon kind={current.kind} className="size-3.5 text-icon" />
                <span className="min-w-0 truncate text-text-muted">
                  {KIND_LABEL[current.kind]}
                  {current.model ? ` · ${current.model}` : ""}
                </span>
                <span className="flex-1" />
                <StopEntry entry={current} onStop={() => sim.stopEntry(current.id)} />
              </div>
              <pre className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-text-muted">
                {current.lines.join("\n") || "No output yet."}
                <div ref={end} />
              </pre>
              <div className="shrink-0 px-3 pb-2 text-[10.5px] text-placeholder">↑↓ select · x stop</div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

// ───────────────────────────── C · Status line ─────────────────────────────

type Sheet = "agents" | "queue" | "context" | null;

export function VariantC({ sim }: { sim: Sim }) {
  const d = useDraft(sim);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const entry = sim.entries.find((e) => e.id === open);
  const running = sim.entries.filter((e) => e.state === "running");
  const agents = running.filter((e) => e.kind === "agent" || e.kind === "crew").length;
  const shells = running.filter((e) => e.kind === "shell" || e.kind === "process").length;
  const { share } = contextShare(sim);

  useEffect(() => {
    if (sheet !== "agents" || open) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSheet(null);
      if (e.key === "ArrowDown") setCursor((c) => Math.min(sim.entries.length - 1, c + 1));
      if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
      if (e.key === "Enter") setOpen(sim.entries[cursor]?.id ?? null);
      if (e.key === "x") {
        const target = sim.entries[cursor];
        if (target) sim.stopEntry(target.id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sheet, open, cursor, sim]);

  // ⌘⇧F flips fast from anywhere.
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        sim.toggleFast();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sim]);

  const seg = "flex h-6 items-center gap-1.5 rounded-md px-1.5 hover:bg-hover hover:text-text";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Thread items={sim.items} working={sim.working} onOpenEntry={setOpen} />
      </div>
      <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2">
        <div className="crew-composer relative">
          {sim.queue.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {sim.queue.map((q) => (
                <span key={q.id} className="group flex h-7 max-w-full items-center gap-1.5 rounded-full bg-card pr-1 pl-2.5 text-[12px]">
                  <span className="text-[10.5px] text-text-muted">{q.mode === "steer" ? "↳ this turn" : "⏎ next turn"}</span>
                  <span className="max-w-[260px] truncate">{q.text}</span>
                  <button type="button" onClick={() => sim.removeQueued(q.id)} className="grid size-5 place-items-center rounded-full text-text-muted hover:bg-selected hover:text-text">
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Field sim={sim} d={d} />
          <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Chips sim={sim} fast={null} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <SendStop sim={sim} d={d} />
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-0.5 px-1 font-mono text-[11px] text-text-muted">
          <button type="button" className={seg} onClick={() => setSheet(sheet === "context" ? null : "context")} title={ContextTitle(sim)}>
            <ContextRing sim={sim} label={false} />
            <span className={share >= 0.85 ? "text-danger" : share >= 0.7 ? "text-warning" : ""}>ctx {Math.round(share * 100)}%</span>
          </button>
          <span className="text-placeholder">·</span>
          <button type="button" className={seg} onClick={() => setSheet(sheet === "agents" ? null : "agents")}>
            {agents} agent{agents === 1 ? "" : "s"} · {shells} shell{shells === 1 ? "" : "s"}
            {running.length > 0 && <span className="crew-bg-dot" />}
          </button>
          {sim.queue.length > 0 && (
            <>
              <span className="text-placeholder">·</span>
              <button type="button" className={seg} onClick={() => setSheet(sheet === "queue" ? null : "queue")}>
                {sim.queue.length} waiting
              </button>
            </>
          )}
          {!fastHidden(sim.fast) && (
            <>
              <span className="text-placeholder">·</span>
              <button
                type="button"
                className={`${seg} ${sim.fast.on ? "text-warning" : ""}`}
                onClick={sim.toggleFast}
                title={sim.fast.availability === "cooldown" ? "Cooling down after a rate limit" : "⌘⇧F"}
              >
                <ZapIcon className={`size-3 ${sim.fast.on ? "fill-current" : ""}`} />
                {sim.fast.on ? (sim.fast.availability === "cooldown" ? "fast · cooling" : "fast") : "standard"}
              </button>
            </>
          )}
          <span className="flex-1" />
          <span className="text-placeholder">esc stop · ↵ {sim.working ? (sim.canSteer ? "steer" : "queue") : "send"}</span>
        </div>
      </div>
      {sheet && !open && (
        <div className="absolute inset-x-0 bottom-[150px] z-10 mx-auto w-full max-w-[712px] rounded-2xl bg-surface p-1.5 shadow-float ring-1 ring-border">
          {sheet === "agents" && (
            <>
              <div className="flex items-center px-2 pt-1 pb-1.5 text-[11px] text-text-muted">
                Background work
                <span className="flex-1" />
                <button type="button" onClick={sim.clearFinished} className="rounded px-1.5 hover:bg-hover hover:text-text">
                  Clear finished
                </button>
              </div>
              {sim.entries.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => setOpen(e.id)}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12.5px] ${i === cursor ? "bg-selected" : ""}`}
                >
                  <StateDot state={e.state} />
                  <EntryMark entry={e} />
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  <span className="shrink-0 text-[11px] text-text-muted">{KIND_LABEL[e.kind]}</span>
                  <span className="w-16 shrink-0 text-right text-[11px] text-text-muted tabular-nums">{elapsed(e.startedAt, e.endedAt ?? sim.now)}</span>
                </button>
              ))}
              <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] text-placeholder">↑↓ select · ↵ open · x stop · esc close</div>
            </>
          )}
          {sheet === "queue" && sim.queue.map((q, i) => <QueuedRow key={q.id} sim={sim} q={q} index={i} />)}
          {sheet === "context" && (
            <div className="flex flex-col gap-2 p-2 text-[12.5px]">
              <ContextBar sim={sim} />
              <div className="flex justify-between text-text-muted">
                <span>{tokens(sim.context.used)} used</span>
                <span>{sim.context.autoCompactAt ? `compacts at ${tokens(sim.context.autoCompactAt)}` : "Codex compacts on its own"}</span>
                <span>{tokens(sim.context.window)} window</span>
              </div>
              <button type="button" className="self-start rounded-md px-2 py-1 text-[12px] ring-1 ring-hairline hover:bg-hover">
                /compact now
              </button>
            </div>
          )}
        </div>
      )}
      {entry && <OutputOverlay sim={sim} entry={entry} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ───────────────────────────── E · C, refined ─────────────────────────────
// C's status line and sheets, after the first review: no monospace, A's ring
// for the context, segments only when there is something to say, sheets close
// on a click outside, chips without chevrons, and fast rides the model chip.

/** Model and effort as quiet chips: no chevron, the chip itself opens the menu. */
function QuietChips({ sim }: { sim: Sim }) {
  return (
    <>
      <button type="button" aria-label="Attach files" className="crew-composer-plus shrink-0">
        <PaperclipIcon className="size-4" />
      </button>
      <span className={CHIP}>
        <Mark provider={sim.provider} className="size-3.5" />
        {sim.model}
      </span>
      <span className={CHIP}>
        <BrainIcon className="size-3.5 text-icon" />
        High
      </span>
      <FastChip fast={sim.fast} onToggle={sim.toggleFast} />
    </>
  );
}

export function VariantE({ sim }: { sim: Sim }) {
  const d = useDraft(sim);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const entry = sim.entries.find((e) => e.id === open);
  const running = sim.entries.filter((e) => e.state === "running");
  const finished = sim.entries.length - running.length;
  const agents = running.filter((e) => e.kind === "agent" || e.kind === "crew").length;
  const shells = running.filter((e) => e.kind === "shell").length;
  const processes = running.filter((e) => e.kind === "process").length;
  const work = [
    agents && `${agents} agent${agents > 1 ? "s" : ""}`,
    shells && `${shells} shell${shells > 1 ? "s" : ""}`,
    processes && `${processes} process${processes > 1 ? "es" : ""}`,
  ].filter(Boolean);

  // A click anywhere outside the sheet, or the line that opened it, closes it.
  useEffect(() => {
    if (!sheet) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (sheetRef.current?.contains(t) || lineRef.current?.contains(t)) return;
      setSheet(null);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [sheet]);

  useEffect(() => {
    if (sheet !== "agents" || open) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSheet(null);
      if (e.key === "ArrowDown") setCursor((c) => Math.min(sim.entries.length - 1, c + 1));
      if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
      if (e.key === "Enter") setOpen(sim.entries[cursor]?.id ?? null);
      if (e.key === "x") {
        const target = sim.entries[cursor];
        if (target) sim.stopEntry(target.id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sheet, open, cursor, sim]);

  const seg = "flex h-6 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-hover hover:text-text";
  const dot = <span className="text-placeholder">·</span>;
  const segments: ReactNode[] = [<ContextHover key="ctx" sim={sim} />];
  if (work.length > 0)
    segments.push(
      <button key="work" type="button" className={seg} onClick={() => setSheet(sheet === "agents" ? null : "agents")}>
        <span className="crew-bg-dot" />
        {work.join(" · ")}
      </button>,
    );
  else if (finished > 0)
    segments.push(
      <button key="work" type="button" className={`${seg} text-placeholder`} onClick={() => setSheet(sheet === "agents" ? null : "agents")}>
        {finished} finished
      </button>,
    );
  if (sim.queue.length > 0)
    segments.push(
      <button key="queue" type="button" className={seg} onClick={() => setSheet(sheet === "queue" ? null : "queue")}>
        <ListOrderedIcon className="size-3" />
        {sim.queue.length} waiting
      </button>,
    );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Thread items={sim.items} working={sim.working} onOpenEntry={setOpen} />
      </div>
      <div className="relative mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2">
        {sheet && !open && (
          <div ref={sheetRef} className="absolute inset-x-6 bottom-full z-10 mb-2 flex max-h-[min(60vh,460px)] flex-col overflow-y-auto overscroll-contain rounded-2xl bg-surface p-1.5 shadow-float ring-1 ring-border">
            {sheet === "agents" && (
              <>
                <div className="flex items-center px-2 pt-1 pb-1.5 text-[11px] text-text-muted">
                  Background work
                  <span className="flex-1" />
                  {finished > 0 && (
                    <button type="button" onClick={sim.clearFinished} className="rounded px-1.5 hover:bg-hover hover:text-text">
                      Clear finished
                    </button>
                  )}
                </div>
                {sim.entries.map((e, i) => (
                  <div
                    key={e.id}
                    role="button"
                    tabIndex={0}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => setOpen(e.id)}
                    className={`group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left ${i === cursor ? "bg-hover" : ""}`}
                  >
                    <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-card">
                      {e.provider ? <Mark provider={e.provider} className="size-4" /> : <KindIcon kind={e.kind} className="size-4 text-icon" />}
                      <span className="absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center rounded-full bg-surface">
                        <StateDot state={e.state} />
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate text-[13px] leading-[18px] ${e.state === "running" ? "" : "text-text-muted"}`}>{e.title}</span>
                      <span className="truncate text-[11.5px] leading-4 text-text-muted">
                        {KIND_LABEL[e.kind]} · {e.state === "running" ? elapsed(e.startedAt, sim.now) : `${stateWord(e)} after ${elapsed(e.startedAt, e.endedAt ?? sim.now)}`}
                        {e.tokens !== undefined && (
                          <span title={e.window ? `${tokens(e.tokens)} of its ${tokens(e.window)} context` : "Tokens used"}>
                            {" · "}
                            {tokens(e.tokens)} tokens
                          </span>
                        )}
                        {e.state === "running" && e.lines.at(-1) ? <span className="text-placeholder"> · {e.lines.at(-1)}</span> : null}
                      </span>
                    </span>
                    <QuietStop entry={e} onStop={() => sim.stopEntry(e.id)} />
                  </div>
                ))}
                <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] text-placeholder">↑↓ select · ↵ open · x stop · esc close</div>
              </>
            )}
            {sheet === "queue" && sim.queue.map((q, i) => <QueuedRow key={q.id} sim={sim} q={q} index={i} />)}
            {sheet === "context" && (
              <div className="flex flex-col gap-2 p-2 text-[12.5px]">
                <ContextBar sim={sim} />
                <div className="flex justify-between text-text-muted">
                  <span>{tokens(sim.context.used)} used</span>
                  <span>{sim.context.autoCompactAt ? `compacts at ${tokens(sim.context.autoCompactAt)}` : `${sim.provider} compacts on its own`}</span>
                  <span>{tokens(sim.context.window)} window</span>
                </div>
                <button type="button" className="self-start rounded-md px-2 py-1 text-[12px] ring-1 ring-hairline hover:bg-hover">
                  Compact now
                </button>
              </div>
            )}
          </div>
        )}
        <div className="crew-composer relative">
          {sim.queue.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {sim.queue.map((q) => (
                <span key={q.id} className="group flex h-7 max-w-full items-center gap-1.5 rounded-full bg-card pr-1 pl-2.5 text-[12px]">
                  <span className="text-[11px] text-text-muted">{q.mode === "steer" ? "this turn" : "next turn"}</span>
                  <span className="max-w-[260px] truncate">{q.text}</span>
                  <button type="button" onClick={() => sim.removeQueued(q.id)} className="grid size-5 place-items-center rounded-full text-text-muted hover:bg-selected hover:text-text">
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Field sim={sim} d={d} />
          <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <QuietChips sim={sim} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className={CHIP}>
                <LockIcon className="size-3.5 text-icon" />
                Ask
              </span>
              <SendStop sim={sim} d={d} />
            </div>
          </div>
        </div>
        <div ref={lineRef} className="mt-1.5 flex items-center gap-0.5 px-1 text-[11.5px] text-text-muted">
          {segments.map((node, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && dot}
              {node}
            </span>
          ))}
          <span className="flex-1" />
          <span className="text-placeholder">{sim.working ? `esc stop · ↵ ${sim.canSteer ? "add to the turn" : "queue"} · ⌘↵ next turn` : "↵ send · ⇧↵ new line"}</span>
        </div>
      </div>
      {entry && <EntryView sim={sim} entry={entry} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * Stop without a background of its own: the row's hover is the only fill,
 * and the word turns red under the pointer. Hidden until the row is hovered.
 */
function QuietStop({ entry, onStop }: { entry: Entry; onStop: () => void }) {
  if (entry.state !== "running") return <span className="w-12 shrink-0" />;
  if (entry.stoppable !== true)
    return (
      <span title={entry.stoppable} className="w-12 shrink-0 text-right text-[11px] text-placeholder">
        —
      </span>
    );
  return (
    <button
      type="button"
      title="Stop (x)"
      onClick={(e) => {
        e.stopPropagation();
        onStop();
      }}
      className="flex w-12 shrink-0 items-center justify-end gap-1 text-[11.5px] text-text-muted opacity-0 transition-[color,opacity] group-hover:opacity-100 hover:text-danger"
    >
      <SquareIcon className="size-2.5 fill-current" />
      Stop
    </button>
  );
}

/** One subagent's or shell's work, as its own page over the chat. */
function EntryView({ sim, entry, onClose }: { sim: Sim; entry: Entry; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const agent = entry.kind === "agent" || entry.kind === "crew";
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entry.lines.length]);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "x" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) sim.stopEntry(entry.id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [entry.id, onClose, sim]);
  const meta = [KIND_LABEL[entry.kind], entry.model, entry.detail].filter(Boolean).join(" · ");
  const fade = "[mask-image:linear-gradient(to_bottom,transparent,black_28px,black_calc(100%-56px),transparent)]";
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-canvas">
      <header className="mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-3 px-6 pt-5 pb-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-card">
          {entry.provider ? <Mark provider={entry.provider} className="size-[18px]" /> : <KindIcon kind={entry.kind} className="size-[18px] text-icon" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] leading-5 font-medium">{entry.title}</span>
          <span className="truncate text-[12px] leading-4 text-text-muted">{meta}</span>
        </div>
        {/* Facts as plain text, the way Linear writes an issue's properties: no pills. */}
        <span className="flex shrink-0 items-center gap-3 text-[12px] text-text-muted tabular-nums">
          {entry.tokens !== undefined && (
            <span
              title={entry.window ? `${tokens(entry.tokens)} of its ${tokens(entry.window)} context` : "Tokens this subagent has used"}
              className="flex items-center gap-1.5"
            >
              {tokens(entry.tokens)} tokens
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <StateDot state={entry.state} />
            <span className="text-text">{stateWord(entry)[0]!.toUpperCase() + stateWord(entry).slice(1)}</span>
            {elapsed(entry.startedAt, entry.endedAt ?? sim.now)}
          </span>
        </span>
        <span className="h-4 w-px shrink-0 bg-hairline" />
        {/* A Crew subagent's Stop is in its composer, as the session's is. Same
            weight as Close: the page is for reading, stopping is the aside;
            only the pointer turns it red, as the sheet's row Stop does. */}
        {entry.kind !== "crew" && entry.state === "running" && entry.stoppable === true && (
          <Button variant="ghost" keys="x" onClick={() => sim.stopEntry(entry.id)} className="group/stop h-7 px-2 text-[12.5px] font-normal hover:text-danger">
            <SquareIcon className="size-2.5 fill-current text-icon group-hover/stop:text-danger" />
            Stop
          </Button>
        )}
        <Button variant="ghost" keys="esc" onClick={onClose} className="h-7 px-2 text-[12.5px] font-normal">
          Close
        </Button>
      </header>
      <div ref={scroller} className={`min-h-0 flex-1 overflow-y-auto ${fade}`}>
        <div className="mx-auto w-full max-w-[760px] px-6 pt-6 pb-20">
          {agent ? (
            <div className="-mx-6 -mt-6">
              <Thread items={entry.items} working={entry.state === "running"} />
            </div>
          ) : (
            <div className="rounded-2xl bg-sidebar px-5 py-4 ring-1 ring-hairline">
              <div className="mb-3 flex items-center gap-2 font-mono text-[12px] text-text-muted">
                <span className="text-placeholder">$</span>
                {entry.title}
              </div>
              <pre className="font-mono text-[12.5px] leading-[20px] whitespace-pre-wrap">{entry.lines.join("\n")}</pre>
            </div>
          )}
        </div>
      </div>
      {entry.kind === "crew" && <SubagentComposer sim={sim} entry={entry} />}
    </div>
  );
}

/**
 * A Crew subagent is a session of its own, so it gets the session's composer:
 * Enter adds to its running turn; Esc goes back to the chat.
 */
function SubagentComposer({ sim, entry }: { sim: Sim; entry: Entry }) {
  const running = entry.state === "running";
  const target: Target = {
    send: (text) => sim.messageEntry(entry.id, text),
    stop: () => sim.stopEntry(entry.id),
    working: running,
    canSteer: true,
  };
  // Esc here goes back to the chat; the Stop button stops it.
  const d = useDraft(target, false);
  return (
    <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-3">
      <div className="crew-composer relative">
        <Field sim={target} d={d} hint={running ? `Message ${entry.title} — it reads it at its next step` : `Message ${entry.title} — starts a new turn`} />
        <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <button type="button" aria-label="Attach files" className="crew-composer-plus shrink-0">
              <PaperclipIcon className="size-4" />
            </button>
            {entry.provider && (
              <span className={CHIP}>
                <Mark provider={entry.provider} className="size-3.5" />
                {entry.model ?? MODEL[entry.provider]}
              </span>
            )}
            <span className={CHIP}>
              <BrainIcon className="size-3.5 text-icon" />
              Medium
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <SendStop sim={target} d={d} />
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-placeholder">
        ↵ adds to its turn · its report goes to the session that started it · esc back to the chat
      </p>
    </div>
  );
}

// ───────────────────────────── D · Fast gallery ─────────────────────────────

const STATES: { label: string; fast: Fast }[] = [
  { label: "Off", fast: { availability: "available", on: false } },
  { label: "On", fast: { availability: "available", on: true } },
  { label: "Cooldown (rate limited)", fast: { availability: "cooldown", on: true } },
  { label: "No extra usage", fast: { availability: "extra_usage_disabled", on: false } },
];

function GalleryRow({ title, note, render }: { title: string; note: string; render: (fast: Fast) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl p-4 ring-1 ring-hairline">
      <div className="flex items-baseline gap-2">
        <span className="text-[13.5px] font-medium">{title}</span>
        <span className="text-[12px] text-text-muted">{note}</span>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {STATES.map((s) => (
          <div key={s.label} className="flex flex-col gap-1.5">
            <span className="text-[11px] text-text-muted">{s.label}</span>
            <div className="flex h-12 items-center gap-1.5 rounded-xl bg-card px-2.5">{render(s.fast)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function VariantD({ sim }: { sim: Sim }) {
  const noop = () => undefined;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-6 py-8">
        <div>
          <h2 className="text-[18px] font-semibold">Fast mode, five ways</h2>
          <p className="text-[13px] text-text-muted">
            Each row in every state. "No extra usage" is what your account returns: the control is hidden, per plan decision 16. The last row is live:
            flip availability in the scenario bar.
          </p>
        </div>
        <GalleryRow title="1 · Today's chip" note="One chip that toggles; the bolt fills when on." render={(f) => <FastChip fast={f} onToggle={noop} />} />
        <GalleryRow
          title="2 · Standard | Fast"
          note="Both speeds always named, so 'off' is never ambiguous."
          render={(f) => <FastSegmented fast={f} onToggle={noop} />}
        />
        <GalleryRow
          title="3 · Bolt on the model chip"
          note="Speed is a property of the model run, so it lives on the model chip. One fewer chip."
          render={(f) => <ModelFastChip model="Opus 5.5" fast={f} onToggle={noop} />}
        />
        <GalleryRow
          title="4 · On the send button"
          note="The bolt rides the send button while fast is on; ⌥↵ would send one message fast without turning it on (to verify: Claude's fast mode is per session)."
          render={(f) => (
            <span className="flex items-center gap-1.5">
              {!fastHidden(f) && (
                <span className="text-[10.5px] text-text-muted">{f.on ? (f.availability === "cooldown" ? "fast · cooling" : "fast") : "⌥↵ fast once"}</span>
              )}
              <span className={`relative flex size-[30px] items-center justify-center rounded-full ${f.on && !fastHidden(f) ? "bg-warning text-black" : "crew-ink"}`}>
                {f.on && !fastHidden(f) ? <ZapIcon className={`size-4 fill-current ${f.availability === "cooldown" ? "opacity-50" : ""}`} /> : <ArrowUpIcon className="size-4" />}
              </span>
            </span>
          )}
        />
        <GalleryRow
          title="5 · In the status line, ⌘⇧F"
          note="Out of the chips entirely; one segment of the line under the composer, and a shortcut."
          render={(f) =>
            fastHidden(f) ? (
              <span className="font-mono text-[11px] text-placeholder">ctx 41% · 2 agents</span>
            ) : (
              <span className="font-mono text-[11px] text-text-muted">
                ctx 41% · 2 agents ·{" "}
                <span className={f.on ? "text-warning" : ""}>
                  <ZapIcon className={`inline size-3 ${f.on ? "fill-current" : ""}`} /> {f.on ? (f.availability === "cooldown" ? "fast · cooling" : "fast") : "standard"}
                </span>
              </span>
            )
          }
        />
        <div className="flex items-center gap-3 rounded-2xl p-4 ring-1 ring-hairline">
          <GaugeIcon className="size-4 text-icon" />
          <span className="text-[13px]">Live:</span>
          <FastSegmented fast={sim.fast} onToggle={sim.toggleFast} />
          <ModelFastChip model={sim.model} fast={sim.fast} onToggle={sim.toggleFast} />
          <span className="text-[12px] text-text-muted">change the availability in the scenario bar, top right</span>
        </div>
      </div>
    </div>
  );
}



// ───────────────────────────── F · Orchestration ─────────────────────────────
// How the new tools read in a chat (plan 2026-10-07-subagents-and-sessions):
// delegate, start_session(s), send_message, letters that arrive, reports,
// forwarded questions, interrupt_session, update_session, stop_session,
// read_session and list_peers — from the orchestrator's side and from the
// side of a session it started.

type Peer = { name: string; provider: Provider; kind: "subagent" | "session" | "bot"; branch?: string };
const PEERS: Record<string, Peer> = {
  billing: { name: "billing-ui", provider: "claude", kind: "session", branch: "fix/billing-empty-state" },
  refunds: { name: "refunds-api", provider: "codex", kind: "session", branch: "feat/partial-refunds" },
  docs: { name: "docs-sweep", provider: "opencode", kind: "session", branch: "docs/refunds" },
  scout: { name: "Find refund call sites", provider: "codex", kind: "subagent" },
  reviewer: { name: "Reviewer", provider: "claude", kind: "bot" },
};

/** One tool row in the chat's own dialect: the node glyph, a sentence, and what it touched. */
function ToolRow({ icon: Glyph, children }: { icon: typeof SendIcon; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center gap-2 text-[13px] leading-[18px] text-text-muted">
      <span className="crew-node">
        <Glyph className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

function PeerName({ peer }: { peer: Peer }) {
  return (
    <span className="inline-flex items-center gap-1 align-[-3px] text-text">
      <Mark provider={peer.provider} className="size-3.5" />
      {peer.name}
    </span>
  );
}

/** A card hanging under a row: indented to the row's text, hairline, the app's radius. */
function Hang({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ml-[26px] rounded-xl ring-1 ring-hairline ${className}`}>{children}</div>;
}

function SessionLine({ peer, state, detail, prompt }: { peer: Peer; state: Entry["state"]; detail: string; prompt?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
    <button type="button" onClick={() => prompt && setOpen((o) => !o)} className="group flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px]">
      <StateDot state={state} />
      <Mark provider={peer.provider} className="size-3.5" />
      <span className="truncate text-text">{peer.name}</span>
      {peer.branch && <span className="truncate text-text-muted">{peer.branch}</span>}
      <span className="min-w-0 flex-1 truncate text-placeholder">{detail}</span>
      {prompt && <ChevronDownIcon className={`size-3.5 shrink-0 text-icon transition-transform ${open ? "rotate-180" : ""}`} />}
    </button>
    {open && prompt && (
      <div className="border-t border-hairline px-3.5 py-3">
        <LongText text={prompt} />
      </div>
    )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <ToolRow icon={SparklesIcon}>
      <span className="text-text-muted">Thought for 6s</span>
      <span className="text-placeholder"> · {text}</span>
    </ToolRow>
  );
}

/**
 * A message from another session or a bot, read like a comment from another
 * participant: who wrote it on one line, what they said under it. Not the
 * user's bubble, and no box around it.
 */
function Letter({
  from,
  text,
  tag,
  envelope,
  long = false,
  children,
}: {
  from: Peer | "orchestrator";
  text: string;
  tag?: string;
  envelope?: string;
  long?: boolean;
  children?: ReactNode;
}) {
  const peer: Peer = from === "orchestrator" ? { name: "orchestrator", provider: "claude", kind: "session" } : from;
  return (
    <div className="flex gap-2.5 py-1">
      <span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-card">
        <Mark provider={peer.provider} className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5 text-[12.5px]">
          <span className="font-medium text-text">{peer.name}</span>
          <span className="text-text-muted">{envelope ?? (peer.kind === "bot" ? "bot" : peer.kind)}</span>
          {tag && <span className="text-placeholder">· {tag}</span>}
        </div>
        {long ? <LongText text={text} /> : <p className="text-[14px] leading-[21px]">{text}</p>}
        {children}
      </div>
    </div>
  );
}

/** A handoff is usually long: markdown, folded to a few lines, with a way to read it all. */
function LongText({ text, lines = 7 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const total = text.split("\n").length;
  const folds = total > lines + 2;
  return (
    <div className="flex flex-col">
      <div
        className={`relative text-[14px] leading-[21px] ${folds && !open ? "overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : ""}`}
        style={folds && !open ? { maxHeight: `${lines * 21}px` } : undefined}
      >
        <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
          <Markdown text={text} />
        </Suspense>
      </div>
      {folds && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 self-start rounded-md px-1.5 py-0.5 -ml-1.5 text-[12px] text-text-muted transition-colors hover:bg-hover hover:text-text">
          {open ? "Show less" : `Show all · ${total} lines`}
        </button>
      )}
    </div>
  );
}

const HANDOFF = `Vas a implementar partial refunds en \`POST /refunds\`. Trabajas solo en el worktree \`~/furry/refunds-partial\`, rama \`feat/partial-refunds\`, que sale de \`master\`. Antes de empezar, lee \`AGENTS.md\` y \`docs/billing/refunds.md\`. Responde en español.

## Entorno: no pises al usuario
- El usuario trabaja en \`master\` en el checkout principal, con \`pnpm dev:all\` corriendo (staff 3200, API 8000). No toques ese checkout ni levantes servidores en esos puertos.
- PHPUnit usa \`furryapp_testing\`, compartida con el checkout principal. Las dependencias ya están instaladas.
- Git no tiene identidad configurada: usa \`GIT_AUTHOR_NAME="Agents Sandbox"\` en el mismo comando.
- Un commit por decisión, con la convención de \`AGENTS.md\`. Al terminar, push de \`feat/partial-refunds\`.

## Lo que ya está hecho (no rehacer)
- \`fix(payments)\`: tarjeta guardada con 3DS; el rechazo off-session deja el pago pendiente.
- \`feat(realtime)\`: \`RefundIssued\` se emite en \`location.{id}.billing\`.
- En la base de dev, "Testing Grooming Co." quedó conectada a la cuenta Connect de test. No lo deshagas.

## La tarea
1. \`amount\` opcional en el body; sin él, el reembolso es total como hoy.
2. Nunca más de lo cobrado menos lo ya reembolsado: \`RefundError::OverRefund\`.
3. Webhooks: \`charge.refunded\` ya lee \`amount\`; \`refund.updated\` no, corrígelo.
4. Formulario de admin (\`admin/refunds.tsx\`): campo de monto, por defecto el total.

## Preguntas de producto
Pregúntame con send_message a este id, no al usuario. Lo que no sea de producto, decídelo tú y dilo en el reporte.

## Al terminar
Reporta: commits, tests que agregaste, y cualquier cosa que no hayas podido verificar.`;

function OrchestratorChat({ sim, onOpen }: { sim: Sim; onOpen: (id: string) => void }) {
  const crew = sim.entries.find((e) => e.kind === "crew");
  const [answered, setAnswered] = useState<string | null>(null);
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-6">
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-card px-3.5 py-2 text-[14px] leading-[21px]">
          Three small jobs today: the billing empty state, partial refunds in the API, and the refunds docs. One worktree each. Ask me product questions, not
          them.
        </div>
      </div>
      <Thinking text="Three independent jobs; the docs depend on the API's shape." />
      <p className="text-[14px] leading-[22px]">I'll start one session per job and scout the refund call sites first so the API session starts informed.</p>

      <ToolRow icon={BotIcon} aside="delegate">
        Delegated to a subagent <PeerName peer={PEERS.scout!} />
      </ToolRow>
      <Hang>
        <button type="button" onClick={() => crew && onOpen(crew.id)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] hover:bg-hover rounded-xl">
          <StateDot state="done" />
          <span className="truncate text-text">Find every caller of refund() and what each expects back</span>
          <span className="flex-1" />
          <span className="shrink-0 text-text-muted tabular-nums">31k tokens · done after 48s</span>
        </button>
      </Hang>
      <div className="ml-[26px] flex flex-col gap-1">
        <span className="text-[12px] text-text-muted">
          Report from <PeerName peer={PEERS.scout!} />
        </span>
        <div className="rounded-xl bg-card px-3.5 py-2.5 text-[13.5px] leading-[20px] text-text-muted">
          4 callers. <span className="text-text">checkout/refund.ts</span> and <span className="text-text">admin/refunds.tsx</span> expect a full refund only;
          the two webhooks already read <code className="text-text">amount</code>. Partial refunds need the admin form and one webhook test.
        </div>
      </div>

      <ToolRow icon={MessagesSquareIcon} aside="start_sessions">
        Started 3 sessions, one worktree each
      </ToolRow>
      <span className="-mt-2 ml-[26px] text-[11.5px] text-placeholder">They're yours now: in the sidebar, and in Background work while they run.</span>
      <Hang className="divide-y divide-hairline">
        <SessionLine peer={PEERS.billing!} state="running" detail="Editing EmptyState.tsx" prompt={HANDOFF.replace("partial refunds en `POST /refunds`", "el empty state de billing")} />
        <SessionLine peer={PEERS.refunds!} state="running" detail="Running cargo test" prompt={HANDOFF} />
        <SessionLine peer={PEERS.docs!} state="running" detail="Reading docs/refunds.md" prompt={HANDOFF.replace("partial refunds en `POST /refunds`", "la documentación de refunds")} />
      </Hang>

      <Letter from={PEERS.refunds!} tag="waits on an answer" envelope="asks" text="Partial refunds over 90 days: allow them, or keep the 90-day limit that full refunds have?">
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {["Keep the 90-day limit", "Allow them", "Ask the user"].map((option) => (
          <button
            key={option}
            type="button"
            disabled={answered !== null}
            onClick={() => setAnswered(option)}
            className={`h-7 rounded-md px-2.5 text-[12.5px] ring-1 transition-colors ${
              answered === option ? "bg-selected ring-border-strong" : "ring-hairline enabled:hover:bg-hover disabled:opacity-50"
            }`}
          >
            {option}
          </button>
        ))}
        <span className="self-center text-[11.5px] text-placeholder">{answered ? "Answered by you · the first answer counts" : "You or the orchestrator can answer"}</span>
      </div>
      </Letter>

      <Thinking text="The limit applies to refunds-api and docs-sweep; billing-ui doesn't touch refunds." />
      <ToolRow icon={SendIcon} aside="send_message">
        Message to <PeerName peer={PEERS.refunds!} /> and <PeerName peer={PEERS.docs!} />
      </ToolRow>
      <Hang className="px-3.5 py-2.5">
        <LongText
          text={`Decisión: los partial refunds mantienen el límite de 90 días, con el mismo error que los totales (\`RefundError::TooOld\`).

## refunds-api
- Aplica el límite en \`policy.rs\` antes de calcular el monto.
- Agrega un test para un partial refund a los 91 días.

## docs-sweep
- En la tabla de límites de \`docs/billing/refunds.md\`, la fila de 90 días vale para ambos.
- Quita la nota que dice que los parciales "no tienen límite".

No cambies el texto del error: soporte ya lo tiene en sus macros.`}
        />
      </Hang>

      <ToolRow icon={HandIcon} aside="interrupt_session">
        Interrupted <PeerName peer={PEERS.billing!} /> and redirected it
      </ToolRow>
      <Hang className="px-3.5 py-2.5 text-[13.5px] leading-[20px] text-text-muted">
        "Stop the illustration work: use the existing empty-state component, copy only."
      </Hang>

      <ToolRow icon={SendIcon} aside="send_message">
        Asked the bot <PeerName peer={PEERS.reviewer!} /> to review refunds-api's branch
      </ToolRow>
      <Letter from={PEERS.reviewer!} envelope="replied" text="Reviewed feat/partial-refunds: one issue — the webhook test still asserts a full amount. Otherwise good to merge." />

      <ToolRow icon={EyeIcon} aside="read_session">
        Read <PeerName peer={PEERS.billing!} />'s last 12 messages
      </ToolRow>
      <ToolRow icon={UsersIcon} aside="list_peers">
        Listed 7 peers · 3 sessions, 1 subagent, 3 bots
      </ToolRow>
      <ToolRow icon={CircleStopIcon} aside="stop_session">
        Stopped <PeerName peer={PEERS.docs!} /> and its 2 subagents
      </ToolRow>
      <ToolRow icon={ArchiveIcon} aside="update_session">
        Archived <PeerName peer={PEERS.docs!} /> · its transcript stays
      </ToolRow>
      <p className="text-[14px] leading-[22px]">
        refunds-api is ready for review after the webhook test fix; billing-ui is on copy only. I'll tell you when both report.
      </p>
      {sim.working && <span className="crew-bg-dot self-start" aria-label="Working" />}
    </div>
  );
}

/** The other side: a session the orchestrator started, and a letter that reaches it mid-turn. */
function ReceivingChat() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-6">
      <Letter
        from="orchestrator"
        envelope="started this session"
        text={HANDOFF}
        long
      />
      <Thinking text="Amount is optional; the 90-day rule lives in policy.rs." />
      <ToolRow icon={FileTextIcon}>Read crates/api/src/refunds/policy.rs</ToolRow>
      <ToolRow icon={PencilIcon}>Edit crates/api/src/refunds/handler.rs</ToolRow>
      <ToolRow icon={SendIcon} aside="send_message">
        Question to <PeerName peer={{ name: "orchestrator", provider: "claude", kind: "session" }} />: partial refunds over 90 days?
      </ToolRow>
      <ToolRow icon={TerminalIcon}>Running cargo test -p api refunds</ToolRow>
      <Letter from="orchestrator" envelope="wrote" tag="read mid-turn" text="Decision: partial refunds keep the 90-day limit. Same error as full refunds." />
      <p className="text-[14px] leading-[22px]">Got it — keeping the limit. Reusing `RefundError::TooOld` for partial refunds and adding a test.</p>
      <ToolRow icon={PencilIcon}>Edit crates/api/src/refunds/policy.rs</ToolRow>
      <span className="crew-bg-dot self-start" aria-label="Working" />
    </div>
  );
}

export function VariantF({ sim }: { sim: Sim }) {
  const [side, setSide] = useState<"orchestrator" | "receiver">("orchestrator");
  const d = useDraft(sim);
  const [open, setOpen] = useState<string | null>(null);
  const entry = sim.entries.find((e) => e.id === open);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* PROTOTYPE chrome, not product: which chat this variant shows. */}
      <div className="fixed top-3 left-3 z-50 flex items-center gap-1 rounded-full bg-[#111] px-2 py-1 text-[11.5px] text-white shadow-lg">
        <span className="px-1.5 text-white/50">Showing</span>
        {(["orchestrator", "receiver"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSide(s)} className={`rounded-full px-2 py-0.5 ${side === s ? "bg-white/20" : "hover:bg-white/10"}`}>
            {s === "orchestrator" ? "orchestrator" : "refunds-api"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{side === "orchestrator" ? <OrchestratorChat sim={sim} onOpen={setOpen} /> : <ReceivingChat />}</div>
      <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2">
        <div className="crew-composer relative">
          <Field sim={sim} d={d} />
          <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <QuietChips sim={sim} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <SendStop sim={sim} d={d} />
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-0.5 px-1 text-[11.5px] text-text-muted">
          <ContextHover sim={sim} />
          <span className="text-placeholder">·</span>
          <span className="flex h-6 items-center gap-1.5 px-1.5">
            <span className="crew-bg-dot" />3 sessions · 1 agent
          </span>
        </div>
      </div>
      {entry && <EntryView sim={sim} entry={entry} onClose={() => setOpen(null)} />}
    </div>
  );
}

export const VARIANTS = [
  { key: "A", name: "Tray", Component: VariantA },
  { key: "B", name: "Side panel", Component: VariantB },
  { key: "C", name: "Status line", Component: VariantC },
  { key: "D", name: "Fast gallery", Component: VariantD },
  { key: "E", name: "C, refined", Component: VariantE },
  { key: "F", name: "Orchestration", Component: VariantF },
] as const;
