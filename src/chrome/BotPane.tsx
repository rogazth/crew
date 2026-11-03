import { BellIcon, CalendarClockIcon, ChevronRightIcon, CpuIcon, LockIcon, PlusIcon, ShuffleIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BotAvatar } from "./BotAvatar";
import { AddRow, CardHead, PaneCard, PaneRow, PaneTabs } from "./BotPaneParts";
import { BotRules } from "./BotRules";
import { Button, IconButton, Switch } from "./kit";
import { AccessPicker } from "./ComposerControls";
import { ModelPicker } from "./ModelPicker";
import type { useBotSheet } from "../hooks/useBotSheet";
import { useBotAvatar } from "../hooks/useBotAvatar";
import { useBotRules } from "../hooks/useBotRules";
import { useBotFaces } from "../hooks/useBotFaces";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { useRoutines } from "../hooks/useRoutines";
import { BOT_AVATARS, dealSeeds, type BotFace } from "../lib/botAvatar";
import { DEFAULT_PROVIDER, accessesOf, defaultModelOf, type ProviderId } from "../lib/providers";
import { SUBMIT_KEYS } from "../lib/hotkey";
import { describeSchedule, parseSchedule } from "../lib/routines";
import type { Autonomy, Session } from "../lib/types";

export type BotDraft = {
  name: string;
  provider: string;
  model: string;
  description: string;
  notifications: boolean;
  autonomy: Autonomy;
  /** The face it wears: saved against the bot once it exists. */
  face: BotFace;
};

type Sheet = ReturnType<typeof useBotSheet>;

// How long the sheet takes to go (bot-pane-out in index.css).
const LEAVE_MS = 150;
const RAISED_SHADOW = "shadow-[0_0_0_1px_var(--color-hairline),0_1px_2px_oklch(0%_0_0/0.04),0_10px_28px_-14px_oklch(0%_0_0/0.18)]";
const VARIANTS = 5;

/**
 * A bot, in a sheet that comes in over the window from the right, while the
 * window steps back under it (useRecede): it is not a tab, so
 * it takes no place beside them. A press on what stepped back closes it. The bot's name is
 * its heading and what makes it up is listed under it. A bot that exists is
 * changed where it reads, a field at a time, and each change is written as it
 * is made; a new one is drafted and made with Create.
 */
export function BotPaneHost({
  sheet,
  sessions,
  onNewRoutine,
  onOpenRoutine,
}: {
  sheet: Sheet;
  sessions: Session[];
  onNewRoutine: (sessionId: string) => void;
  /** Its editor, for one of the bot's routines, by the routine's id. */
  onOpenRoutine: (routineId: string) => void;
}) {
  // What it shows, held through its way out after the sheet has closed.
  const [held, setHeld] = useState(sheet.sheet);
  if (sheet.sheet && sheet.sheet !== held) setHeld(sheet.sheet);
  const leaving = !sheet.sheet && held !== null;
  useEffect(() => {
    if (!leaving) return;
    // A timer, not animationend: with reduced motion there is no animation to end.
    const timer = window.setTimeout(() => setHeld(null), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const shown = sheet.sheet ?? held;
  if (!shown) return null;
  // The live row, so what was just written shows; the one the pane opened on if it is gone.
  const opened = shown.session;
  const session = opened ? (sessions.find((s) => s.id === opened.id) ?? opened) : null;
  return createPortal(
    <>
      <div
        aria-hidden
        onPointerDown={sheet.close}
        // A whisper of frost: what stepped back softens, and its fade carries the blur in and out with it.
        className={`fixed inset-0 z-50 bg-(--recede-scrim) backdrop-blur-[0.5px] ${leaving ? "dialog-backdrop-out pointer-events-none" : "dialog-backdrop"}`}
      />
      <aside
        aria-label={session ? "Bot settings" : "New bot"}
        inert={leaving}
        // Its top runs under the tab bar's window drag, which would take the clicks meant for it.
        data-tauri-drag-region="false"
        onKeyDown={(event: KeyboardEvent) => {
          // A menu opened from here is portaled out but its keys bubble through React: its Escape is its own.
          if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
          event.stopPropagation();
          sheet.close();
        }}
        className={`fixed top-6 right-6 bottom-6 z-50 flex w-[440px] max-w-[calc(100vw-48px)] flex-col ${leaving ? "bot-pane-out" : "bot-pane-in"}`}
      >
        <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-surface ${RAISED_SHADOW}`}>
          {session ? (
            <BotProfile
              key={session.id}
              session={session}
              sheet={sheet}
              onNewRoutine={() => onNewRoutine(session.id)}
              onOpenRoutine={onOpenRoutine}
            />
          ) : (
            <NewBot key={shown.worktree ?? "new"} sheet={sheet} />
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

/* ── A bot that exists ──────────────────────────────────────────────── */

function BotProfile({
  session,
  sheet,
  onNewRoutine,
  onOpenRoutine,
}: {
  session: Session;
  sheet: Sheet;
  onNewRoutine: () => void;
  onOpenRoutine: (routineId: string) => void;
}) {
  const face = useBotFaces()[session.id] ?? {};
  const rules = useBotRules(session);
  const patch = (fields: Partial<BotDraft>) => void sheet.patch(session, fields);

  return (
    <Identity
      id={session.id}
      face={face}
      onFace={(next) => patch({ face: next })}
      name={session.name}
      onName={(name) => patch({ name })}
      description={session.description}
      onDescription={(description) => patch({ description })}
      onClose={sheet.close}
      tabs={[
        {
          key: "rules",
          label: "Rules",
          content: <BotRules rules={rules} />,
        },
        { key: "routines", label: "Routines", content: <Routines botId={session.id} onNew={onNewRoutine} onOpen={onOpenRoutine} /> },
      ]}
    >
      <RunsOn provider={session.provider} model={session.model || defaultModelOf(session.provider)} autonomy={session.autonomy} onChange={patch} />
      <Notifications on={session.notifications} onChange={(notifications) => patch({ notifications })} />
    </Identity>
  );
}

/** What runs it: the model, and how much it may do without asking. Each row is its picker: a press anywhere on it opens the menu. */
function RunsOn({
  provider,
  model,
  autonomy,
  onChange,
}: {
  provider: string;
  model: string;
  autonomy: Autonomy;
  onChange: (fields: Partial<BotDraft>) => void;
}) {
  return (
    <PaneCard label="Runs on">
      <ModelPicker
        row={{ icon: <CpuIcon className="size-4" />, label: "Model" }}
        provider={provider}
        model={model}
        onChange={(next: ProviderId, nextModel) =>
          onChange({
            provider: next,
            model: nextModel,
            ...(accessesOf(next).includes(autonomy) ? {} : { autonomy: "ask" }),
          })
        }
      />
      <AccessPicker
        row={{ icon: <LockIcon className="size-4" />, label: "Access" }}
        provider={provider}
        value={autonomy}
        onChange={(next) => onChange({ autonomy: next })}
      />
    </PaneCard>
  );
}

/** A press anywhere on the row flips it, not only on the switch. */
function Notifications({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <PaneCard label="Notifications">
      <PaneRow toggles icon={<BellIcon className="size-4" />} title="Notifications">
        <Switch label="Notifications" checked={on} onChange={onChange} />
      </PaneRow>
    </PaneCard>
  );
}

/** Its routines, each with when it runs; a press on one opens its editor, and a new one opens the editor on this bot. */
function Routines({ botId, onNew, onOpen }: { botId: string; onNew: () => void; onOpen: (routineId: string) => void }) {
  const entries = useRoutines();
  const mine = (entries ?? []).filter((entry) => entry.routine.sessionId === botId);
  return (
    <PaneCard label="Routines">
      <CardHead title="Routines" bare />
      {mine.map(({ routine }) => (
        <PaneRow
          key={routine.id}
          icon={<CalendarClockIcon className="size-4" />}
          title={routine.name || "Untitled"}
          line={`${describeSchedule(parseSchedule(routine.schedule))}${routine.enabled ? "" : " · Off"}`}
          onClick={() => onOpen(routine.id)}
        >
          <ChevronRightIcon data-row-go className="size-4 text-icon transition-colors group-hover:text-text" />
        </PaneRow>
      ))}
      <AddRow onClick={onNew}>
        <PlusIcon className="size-4 shrink-0" />
        New routine
      </AddRow>
    </PaneCard>
  );
}

/* ── A bot being made ───────────────────────────────────────────────── */

function NewBot({ sheet }: { sheet: Sheet }) {
  // Seeded once per mount: the CLI probe landing mid-edit must not wipe what was typed.
  const { effective } = useDefaultAgent();
  const [draft, setDraft] = useState<BotDraft>(() => ({
    name: "",
    provider: effective.provider ?? DEFAULT_PROVIDER,
    model: effective.model || defaultModelOf(effective.provider ?? DEFAULT_PROVIDER),
    description: "",
    notifications: true,
    // The access picked in Settings, where this provider offers it.
    autonomy: accessesOf(effective.provider ?? DEFAULT_PROVIDER).includes(effective.access) ? effective.access : "ask",
    // A new bot has no id to draw from yet, so it starts on a seed of its own.
    face: { seed: dealSeeds(1)[0]! },
  }));
  const [saving, setSaving] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<BotDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const name = draft.name.trim();

  async function submit() {
    // Nothing to name it by: back to the name, nothing said.
    if (!name) return nameField.current?.focus();
    if (saving) return;
    setSaving(true);
    try {
      // save holds the spinner for MIN_SAVE_MS so the row, the tab and this close land together.
      await sheet.save({ ...draft, name });
      sheet.close();
    } catch {
      setSaving(false);
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }}
    >
      <Identity
        id={null}
        face={draft.face}
        onFace={(face) => update({ face })}
        name={draft.name}
        draft
        nameRef={nameField}
        onName={(next) => update({ name: next })}
        description={draft.description}
        onDescription={(description) => update({ description })}
        onClose={sheet.close}
      >
        <RunsOn provider={draft.provider} model={draft.model} autonomy={draft.autonomy} onChange={update} />
        <Notifications on={draft.notifications} onChange={(notifications) => update({ notifications })} />
      </Identity>
      {/* No rule over it: what scrolls fades into it. */}
      <div className="relative flex shrink-0 items-center justify-end gap-2 px-4 pt-1 pb-4 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-surface before:to-transparent">
        <Button variant="ghost" onClick={sheet.close}>
          Cancel
        </Button>
        <Button variant="primary" title={SUBMIT_KEYS} loading={saving} onClick={() => void submit()}>
          Create bot
        </Button>
      </div>
    </div>
  );
}

/* ── Who it is ──────────────────────────────────────────────────────── */

/**
 * The sheet's contents, scrolling under a close that stays put: the face and
 * the name as its heading, the face picker when open, the description in a
 * card of its own, then `children`, as a profile reads. With `tabs`, that form
 * is the first tab and the rest sit beside it. The face opens the picker right under
 * it; the name and the description are edited where they are and kept when
 * the edit ends. `draft`: a bot being made, whose name is typed straight into.
 */
function Identity({
  id,
  face,
  onFace,
  name,
  draft = false,
  nameRef,
  onName,
  description,
  onDescription,
  onClose,
  tabs,
  children,
}: {
  id: string | null;
  face: BotFace;
  onFace: (face: BotFace) => void;
  name: string;
  draft?: boolean;
  nameRef?: RefObject<HTMLInputElement | null>;
  onName: (name: string) => void;
  description: string;
  onDescription: (description: string) => void;
  onClose: () => void;
  /** What it is past the form, each a tab beside it; without them the form is all there is, as for a bot being made. */
  tabs?: { key: string; label: string; content: ReactNode }[];
  children: ReactNode;
}) {
  const { avatar } = useBotAvatar();
  const [picking, setPicking] = useState(false);
  const style = face.style ?? avatar;
  // What the face is drawn from: its own seed, else the bot's id.
  const seed = face.seed ?? id ?? "";
  // A bot that exists keeps what is typed to itself until the edit ends.
  const [typed, setTyped] = useState(name);
  const [desc, setDesc] = useState(description);

  // Names may repeat; an empty one puts the old name back.
  const endName = (keep: boolean) => {
    const next = typed.trim();
    if (!keep || !next || next === name) return setTyped(name);
    onName(next);
  };

  // The form: the description, then what it runs on and the rest the caller hands in.
  const form = (
    <>
      <PaneCard label="Description">
        <textarea
          aria-label="Description"
          rows={3}
          value={draft ? description : desc}
          placeholder="Who it is, its job and where it works. It reads this every turn."
          onChange={(event) => (draft ? onDescription(event.target.value) : setDesc(event.target.value))}
          onBlur={() => !draft && desc !== description && onDescription(desc)}
          onKeyDown={(event) => {
            if (draft || event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setDesc(description);
            event.currentTarget.blur();
          }}
          className="block min-h-[76px] w-full resize-none bg-transparent py-3 text-[13px] leading-[19px] outline-none [field-sizing:content] placeholder:text-placeholder"
        />
      </PaneCard>
      {children}
    </>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The close stays in its corner as the rest scrolls under it, on a disc of its own; the name stops short of it. */}
      <IconButton
        icon={XIcon}
        label="Close"
        className="crew-float-ground absolute top-1.5 right-1.5 z-10 size-9"
        onClick={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="flex items-center gap-3 pt-6 pr-12 pb-2 pl-4">
          <button
            type="button"
            aria-label="Change its face"
            aria-expanded={picking}
            title="Change its face"
            onClick={() => setPicking((open) => !open)}
            className={`grid size-14 shrink-0 place-items-center rounded-2xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 ${
              picking ? "bg-card" : "hover:bg-card"
            }`}
          >
            <BotAvatar seed={seed} style={style} bare className="size-12" />
          </button>
          <div className="flex min-w-0 flex-1 flex-col">
            <input
              ref={nameRef}
              autoFocus={draft}
              spellCheck={false}
              value={draft ? name : typed}
              placeholder="Bot name"
              aria-label="Name"
              onChange={(event) => (draft ? onName(event.target.value) : setTyped(event.target.value))}
              onBlur={() => !draft && endName(true)}
              onKeyDown={(event) => {
                if (draft || (event.key !== "Enter" && event.key !== "Escape")) return;
                event.preventDefault();
                event.stopPropagation();
                endName(event.key === "Enter");
                event.currentTarget.blur();
              }}
              className="-mx-1.5 h-9 min-w-0 rounded-md bg-transparent px-1.5 text-[22px] font-semibold tracking-[-0.02em] outline-none transition-colors placeholder:font-normal placeholder:text-placeholder hover:bg-hover focus:bg-hover"
            />
          </div>
        </header>
        <div className="flex flex-col gap-3 px-4 pt-1 pb-10">
          {/* Hard by the face that opened it, and a clear step from the description under it. */}
          {picking && (
            <div className="-mt-1 mb-3">
              <FacePicker seed={seed} face={face} onChange={onFace} />
            </div>
          )}
          {tabs ? (
            <PaneTabs tabs={[{ key: "general", label: "General", content: form }, ...tabs]} />
          ) : (
            form
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Its face, picked the way the rest of the pane is laid out: a card of two
 * rows. Style shows the face it has drawn in every style, so the choice is
 * between faces, not names; picking everyone's style follows it from then on.
 * Face is a hand of others in that style, and a shuffle for a new hand.
 */
function FacePicker({ seed, face, onChange }: { seed: string; face: BotFace; onChange: (face: BotFace) => void }) {
  const { avatar } = useBotAvatar();
  const [hand, setHand] = useState(() => dealSeeds(VARIANTS));
  const style = face.style ?? avatar;
  return (
    <PaneCard label="Face">
      <PaneRow title="Style" line={`${BOT_AVATARS.find((a) => a.id === style)?.label ?? style}${face.style ? "" : " · everyone's"}`}>
        <div role="radiogroup" aria-label="Face style" className="flex items-center gap-0.5">
          {BOT_AVATARS.map((option) => (
            <Choice
              key={option.id}
              label={option.id === avatar ? `${option.label}, everyone's` : option.label}
              on={option.id === style}
              // Everyone's style is followed, not copied: the bot keeps up when it changes.
              onPick={() => onChange(option.id === avatar ? (face.seed ? { seed: face.seed } : {}) : { ...face, style: option.id })}
            >
              <BotAvatar seed={seed} style={option.id} bare className="size-6" />
            </Choice>
          ))}
        </div>
      </PaneRow>
      <PaneRow title="Face" line="Another in this style">
        <div role="radiogroup" aria-label="Face" className="flex items-center gap-0.5">
          {hand.map((candidate) => (
            <Choice key={candidate} label="Use this face" on={candidate === face.seed} onPick={() => onChange({ ...face, seed: candidate })}>
              <BotAvatar seed={candidate} style={style} bare className="size-6" />
            </Choice>
          ))}
          <IconButton icon={ShuffleIcon} label="Deal new faces" title="Deal new faces" className="size-8" onClick={() => setHand(dealSeeds(VARIANTS))} />
        </div>
      </PaneRow>
    </PaneCard>
  );
}

/** One face to pick: raised on the sheet's own surface when it is the one. */
function Choice({ label, on, onPick, children }: { label: string; on: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onPick}
      className={`grid size-8 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 ${
        on ? "bg-surface shadow-[0_0_0_1px_var(--color-hairline),0_1px_2px_oklch(0%_0_0/0.06)]" : "hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
}
