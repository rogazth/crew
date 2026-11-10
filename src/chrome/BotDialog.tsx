// A bot's settings, in a dialog over the window (SettingsDialog.tsx): it is not a tab, so it takes no place beside
// them. The bot's face and name head it. A bot that exists has two pages: General (its instructions, rules, what it
// runs on and its notifications) and Routines (its own); each change is written as it is made, through the sheet's
// patch (useBotSheet) and the rules (useRules). A new one is drafted on General alone and made with Create.
import { BellIcon, CalendarClockIcon, ChevronRightIcon, CpuIcon, LockIcon, PlusIcon, ShuffleIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { BotAvatar } from "./BotAvatar";
import { AddRow, CardHead, PaneCard, PaneRow } from "./BotPaneParts";
import { AccessPicker } from "./ComposerControls";
import { Button, IconButton, Switch } from "./kit";
import { ModelPicker } from "./ModelPicker";
import { DialogName, DialogNameDraft, EditableFace, InstructionsField, SettingsDialog, type DialogPage } from "./SettingsDialog";
import { RulesCard, Section } from "./SettingsSection";
import type { useBotSheet } from "../hooks/useBotSheet";
import { useBotAvatar } from "../hooks/useBotAvatar";
import { useBotFaces } from "../hooks/useBotFaces";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { useRoutines } from "../hooks/useRoutines";
import { useRules } from "../hooks/useRules";
import { useSettingsDialog } from "../hooks/useSettingsDialog";
import { BOT_AVATARS, dealSeeds, type BotFace } from "../lib/botAvatar";
import { SUBMIT_KEYS } from "../lib/hotkey";
import { DEFAULT_PROVIDER, accessesOf, defaultModelOf, type ProviderId } from "../lib/providers";
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
type Page = "general" | "routines";

const PAGES: DialogPage<Page>[] = [
  { key: "general", label: "General" },
  { key: "routines", label: "Routines" },
];
const NEW_PAGES: DialogPage<Page>[] = [{ key: "general", label: "General" }];
const INSTRUCTIONS = "Who it is, its job and where it works. It reads this every turn.";
const VARIANTS = 5;

/**
 * The host: what the sheet has open (a bot, or a new one), held through the
 * dialog's way out. A press outside it, Escape or its close lets it go.
 */
export function BotDialog({
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
  const { shown, leaving, backdrop, panel } = useSettingsDialog(sheet.sheet);
  if (!shown) return null;
  const opened = shown.session;
  const frame = { leaving, backdrop, panel, onLeave: sheet.close };
  // The live row, so what was just written shows; the one it opened on if it is gone.
  if (opened) {
    const bot = sessions.find((s) => s.id === opened.id) ?? opened;
    return <BotSettings key={bot.id} bot={bot} sheet={sheet} frame={frame} onNewRoutine={() => onNewRoutine(bot.id)} onOpenRoutine={onOpenRoutine} />;
  }
  return <NewBot key={shown.worktree ?? "new"} sheet={sheet} frame={frame} />;
}

type Frame = {
  leaving: boolean;
  backdrop: ReturnType<typeof useSettingsDialog>["backdrop"];
  panel: ReturnType<typeof useSettingsDialog>["panel"];
  onLeave: () => void;
};

/* ── A bot that exists ──────────────────────────────────────────────── */

function BotSettings({
  bot,
  sheet,
  frame,
  onNewRoutine,
  onOpenRoutine,
}: {
  bot: Session;
  sheet: Sheet;
  frame: Frame;
  onNewRoutine: () => void;
  onOpenRoutine: (routineId: string) => void;
}) {
  const face = useBotFaces()[bot.id] ?? {};
  const rules = useRules({ kind: "bot", id: bot.id });
  const [page, setPage] = useState<Page>("general");
  // The face picker, opened from the face in the heading, shown at the top of General.
  const [picking, setPicking] = useState(false);
  const patch = (fields: Partial<BotDraft>) => void sheet.patch(bot, fields);
  const seed = face.seed ?? bot.id;

  return (
    <SettingsDialog
      label="Bot settings"
      heading={<DialogName value={bot.name} onKeep={(name) => patch({ name })} />}
      face={
        <FaceButton
          seed={seed}
          face={face}
          onClick={() => {
            setPicking((open) => !open);
            setPage("general");
          }}
        />
      }
      leaving={frame.leaving}
      backdropRef={frame.backdrop}
      panelRef={frame.panel}
      pages={PAGES}
      page={page}
      onPage={setPage}
      onLeave={frame.onLeave}
      renderPage={(key) =>
        key === "general" ? (
          <>
            {picking && (
              <Section>
                <FacePicker seed={seed} face={face} onChange={(next) => patch({ face: next })} />
              </Section>
            )}
            <Section title="Instructions">
              <InstructionsField value={bot.description} onKeep={(description) => patch({ description })} placeholder={INSTRUCTIONS} />
            </Section>
            <Section title="Rules">
              <RulesCard rules={rules} />
            </Section>
            <Section title="Runs on">
              <RunsOn provider={bot.provider} model={bot.model || defaultModelOf(bot.provider)} autonomy={bot.autonomy} onChange={patch} />
            </Section>
            <Section>
              <Notifications on={bot.notifications} onChange={(notifications) => patch({ notifications })} />
            </Section>
          </>
        ) : (
          <Routines botId={bot.id} onNew={onNewRoutine} onOpen={onOpenRoutine} />
        )
      }
    />
  );
}

/* ── A bot being made ───────────────────────────────────────────────── */

function NewBot({ sheet, frame }: { sheet: Sheet; frame: Frame }) {
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
  const [picking, setPicking] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<BotDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const name = draft.name.trim();
  const seed = draft.face.seed ?? "";

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
      className="contents"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }}
    >
      <SettingsDialog
        label="New bot"
        heading={<DialogNameDraft inputRef={nameField} value={draft.name} placeholder="Bot name" onChange={(next) => update({ name: next })} />}
        face={<FaceButton seed={seed} face={draft.face} onClick={() => setPicking((open) => !open)} />}
        leaving={frame.leaving}
        backdropRef={frame.backdrop}
        panelRef={frame.panel}
        pages={NEW_PAGES}
        page="general"
        onPage={() => {}}
        onLeave={frame.onLeave}
        footer={
          <>
            <Button variant="ghost" onClick={frame.onLeave}>
              Cancel
            </Button>
            <Button variant="primary" title={SUBMIT_KEYS} loading={saving} onClick={() => void submit()}>
              Create bot
            </Button>
          </>
        }
        renderPage={() => (
          <>
            {picking && (
              <Section>
                <FacePicker seed={seed} face={draft.face} onChange={(face) => update({ face })} />
              </Section>
            )}
            <Section title="Instructions">
              <InstructionsField draft value={draft.description} onKeep={(description) => update({ description })} placeholder={INSTRUCTIONS} />
            </Section>
            <Section title="Runs on">
              <RunsOn provider={draft.provider} model={draft.model} autonomy={draft.autonomy} onChange={update} />
            </Section>
            <Section>
              <Notifications on={draft.notifications} onChange={(notifications) => update({ notifications })} />
            </Section>
          </>
        )}
      />
    </div>
  );
}

/* ── What it is made of ─────────────────────────────────────────────── */

/** Its face beside its name, as the sidebar draws it; a press opens the face picker. */
function FaceButton({ seed, face, onClick }: { seed: string; face: BotFace; onClick: () => void }) {
  const { avatar } = useBotAvatar();
  return (
    <EditableFace label="Change its face" size="size-12 rounded-[15px]" onClick={onClick}>
      <span className="grid size-full place-items-center bg-card">
        <BotAvatar seed={seed} style={face.style ?? avatar} bare className="size-9" />
      </span>
    </EditableFace>
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

/**
 * Its face, picked as the rest of the dialog is laid out: a card of two rows.
 * Style shows the face it has drawn in every style, so the choice is between
 * faces, not names; picking everyone's style follows it from then on. Face is
 * a hand of others in that style, and a shuffle for a new hand.
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

/** One face to pick: raised on the dialog's own surface when it is the one. */
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
