import { ArrowsClockwiseIcon, FolderIcon, GitBranchIcon, PlusIcon, ShuffleIcon } from "@phosphor-icons/react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { Button, Card, Field, Footer, Overlay, Select, TextArea, TextInput, Toggle, type Option } from "./kit";
import { ModelPicker } from "./ModelPicker";
import { BranchRefused, type useAgentSheet } from "../hooks/useAgentSheet";
import { useAgentAvatar } from "../hooks/useAgentAvatar";
import { useAgentFaces } from "../hooks/useAgentFaces";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { AGENT_AVATARS, dealSeeds, type AgentAvatarId, type AgentFace } from "../lib/agentAvatar";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, type ProviderId } from "../lib/providers";
import type { Autonomy, Session, Worktree } from "../lib/types";
import { branchError, worktreeLabel } from "../lib/worktrees";

/** Where a new agent works: a worktree that exists (null path: the main checkout), or a branch to make one for. */
export type Place = { kind: "worktree"; path: string | null } | { kind: "branch"; branch: string };

export type AgentDraft = {
  name: string;
  provider: string;
  model: string;
  description: string;
  notifications: boolean;
  autonomy: Autonomy;
  place: Place;
  /** The face it wears: saved against the agent once it exists. */
  face: AgentFace;
};

type Props = {
  /** null = creating. */
  session: Session | null;
  worktrees: Worktree[];
  /** Where a new agent starts out working; null is the main checkout. */
  initialWorktree: string | null;
  existingNames: string[];
  /** null while creating: a routine needs an agent that already exists. */
  onNewRoutine: (() => void) | null;
  onSave: (draft: AgentDraft) => Promise<void>;
  onClose: () => void;
};

const VARIANTS = 7;

/** The open sheet, keyed so switching between agents starts a fresh draft. */
export function AgentSheetHost({
  sheet,
  sessions,
  worktrees,
  activeWorktree,
  onNewRoutine,
}: {
  sheet: ReturnType<typeof useAgentSheet>;
  sessions: Session[];
  worktrees: Worktree[];
  /** The worktree on screen; null is the main checkout. */
  activeWorktree: string | null;
  onNewRoutine: (sessionId: string) => void;
}) {
  if (!sheet.sheet) return null;
  const editing = sheet.sheet.session;
  const asked = sheet.sheet.worktree;
  const main = worktrees.find((tree) => tree.main)?.path;
  return (
    <AgentSheet
      key={editing?.id ?? "new"}
      session={editing}
      worktrees={worktrees}
      initialWorktree={asked === undefined ? activeWorktree : asked === main ? null : asked}
      existingNames={sessions.flatMap((s) => (s.kind === "agent" ? [s.name] : []))}
      onNewRoutine={editing ? () => onNewRoutine(editing.id) : null}
      onSave={sheet.save}
      onClose={sheet.close}
    />
  );
}

function nameError(name: string, existingNames: string[], current: string | undefined) {
  if (!name) return "Name is required";
  const lower = name.toLowerCase();
  return existingNames.some((n) => n.toLowerCase() === lower && n !== current)
    ? "An agent with this name already exists"
    : null;
}

/**
 * Making or tuning an agent, in the palette's frame: who it is (face and name),
 * where it works, what runs it, how it behaves. ⌘↵ saves from anywhere in it.
 */
export function AgentSheet({ session, worktrees, initialWorktree, existingNames, onNewRoutine, onSave, onClose }: Props) {
  // Seeded once per mount (the parent keys us by session): the CLI probe landing
  // mid-edit must not wipe what was typed.
  const { effective } = useDefaultAgent();
  const saved = useAgentFaces()[session?.id ?? ""];
  const [draft, setDraft] = useState<AgentDraft>(() =>
    session
      ? {
          name: session.name,
          provider: session.provider,
          model: session.model || DEFAULT_MODEL,
          description: session.description,
          notifications: session.notifications,
          autonomy: session.autonomy,
          place: { kind: "worktree", path: session.worktree },
          face: saved ?? {},
        }
      : {
          name: "",
          provider: effective.provider ?? DEFAULT_PROVIDER,
          model: effective.model ?? DEFAULT_MODEL,
          description: "",
          notifications: true,
          autonomy: "ask",
          place: { kind: "worktree", path: initialWorktree },
          // A new agent has no id to draw from yet, so it starts on a seed of its own.
          face: { seed: dealSeeds(1)[0]! },
        },
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  // What git said of the new branch; it stands until "Works in" is touched again.
  const [refused, setRefused] = useState<string | null>(null);
  const update = (patch: Partial<AgentDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  const name = draft.name.trim();
  const named = nameError(name, existingNames, session?.name);
  const placed = draft.place.kind === "branch" ? branchError(draft.place.branch) : null;

  async function submit() {
    setSubmitted(true);
    if (named || placed || saving) return;
    setSaving(true);
    try {
      // onSave holds the spinner for MIN_SAVE_MS so the row, the tab and this close land together.
      await onSave({ ...draft, name });
      onClose();
    } catch (error) {
      if (error instanceof BranchRefused) setRefused(error.message);
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    void submit();
  }

  return (
    <Overlay onClose={onClose} width="w-[480px]" label={session ? "Agent settings" : "New agent"}>
      <div onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <FacePicker
            id={session?.id ?? null}
            face={draft.face}
            title={session ? "Agent settings" : "New agent"}
            onChange={(face) => update({ face })}
          />

          <Field label="Name" error={submitted ? named : null}>
            <TextInput
              autoFocus
              value={draft.name}
              placeholder="e.g. Research"
              aria-invalid={submitted && named !== null}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>

          {!session && (
            <WorksIn
              worktrees={worktrees}
              place={draft.place}
              error={submitted ? (placed ?? refused) : null}
              onChange={(place) => {
                update({ place });
                setRefused(null);
              }}
            />
          )}

          <Field label="Model">
            <ModelPicker
              provider={draft.provider}
              model={draft.model}
              onChange={(provider: ProviderId, model) => update({ provider, model })}
            />
          </Field>

          <Field label="Description" hint="What it is for, and how it should work. It reads this every turn.">
            <TextArea
              rows={3}
              value={draft.description}
              placeholder="Reviews every change for correctness before it lands"
              onChange={(event) => update({ description: event.target.value })}
            />
          </Field>

          <Card>
            <Toggle
              checked={draft.autonomy === "full"}
              onChange={(checked) => update({ autonomy: checked ? "full" : "ask" })}
              label="Run autonomously"
              description="Tools run without asking. Off, every edit and command waits for Allow."
            />
            <Toggle
              checked={draft.notifications}
              onChange={(checked) => update({ notifications: checked })}
              label="Notifications"
              description="When it finishes or needs you."
            />
          </Card>

          {onNewRoutine && (
            <Button
              icon={ArrowsClockwiseIcon}
              className="w-full"
              onClick={() => {
                onClose();
                onNewRoutine();
              }}
            >
              New routine
            </Button>
          )}
        </div>

        <Footer hints={[["⌘↵", session ? "save" : "create"], ["esc", "cancel"]]}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {session ? "Save" : "Create agent"}
          </Button>
        </Footer>
      </div>
    </Overlay>
  );
}

/**
 * The face, big, with a hand of others in the same style to swap it for. The
 * style is everyone's unless this agent is given its own.
 */
function FacePicker({
  id,
  face,
  title,
  onChange,
}: {
  id: string | null;
  face: AgentFace;
  title: string;
  onChange: (face: AgentFace) => void;
}) {
  const { avatar } = useAgentAvatar();
  const [hand, setHand] = useState(() => dealSeeds(VARIANTS));
  const style = face.style ?? avatar;
  // What the face is drawn from: its own seed, else the agent's id.
  const seed = face.seed ?? id ?? "";
  const styles: Option<"default" | AgentAvatarId>[] = [
    { value: "default", label: `Default (${AGENT_AVATARS.find((a) => a.id === avatar)?.label ?? avatar})` },
    ...AGENT_AVATARS.map((a) => ({ value: a.id, label: a.label })),
  ];

  return (
    <div className="flex items-start gap-4">
      <AgentAvatar seed={seed} style={style} bare className="size-16" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{title}</span>
          <Select
            label="Face style"
            className="w-40"
            value={face.style ?? "default"}
            options={styles}
            onChange={(value) =>
              onChange(value === "default" ? (face.seed ? { seed: face.seed } : {}) : { ...face, style: value })
            }
          />
        </div>
        <div role="radiogroup" aria-label="Face" className="flex items-center gap-1">
          {hand.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === face.seed}
              aria-label="Use this face"
              onClick={() => onChange({ ...face, seed: candidate })}
              className={`grid size-9 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kumo-focus/50 ${
                candidate === face.seed ? "bg-selected" : "hover:bg-hover"
              }`}
            >
              <AgentAvatar seed={candidate} style={style} bare className="size-7" />
            </button>
          ))}
          <button
            type="button"
            title="Deal new faces"
            aria-label="Deal new faces"
            onClick={() => setHand(dealSeeds(VARIANTS))}
            className="grid size-9 place-items-center rounded-lg text-kumo-subtle outline-none hover:bg-hover hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus/50"
          >
            <ShuffleIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where a new agent works: one of the workspace's worktrees, or a new branch that gets its own. */
function WorksIn({
  worktrees,
  place,
  error,
  onChange,
}: {
  worktrees: Worktree[];
  place: Place;
  error: string | null;
  onChange: (place: Place) => void;
}) {
  const [branch, setBranch] = useState(place.kind === "branch" ? place.branch : "");
  const row = (key: string, chosen: boolean, onClick: () => void, children: ReactNode) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-border-strong ${
        chosen ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
  return (
    <Field label="Works in" error={error}>
      <div role="radiogroup" aria-label="Works in" className="flex flex-col gap-0.5 rounded-lg bg-card p-1">
        {worktrees.map((tree) => {
          const path = tree.main ? null : tree.path;
          const Glyph = tree.branch || !tree.main ? GitBranchIcon : FolderIcon;
          return row(tree.path, place.kind === "worktree" && place.path === path, () => onChange({ kind: "worktree", path }), (
            <>
              <Glyph className="size-3.5 shrink-0 text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate">{worktreeLabel(tree)}</span>
              {tree.main && <span className="text-[11px] text-kumo-subtle">main checkout</span>}
            </>
          ));
        })}
        <div
          className={`flex h-8 w-full items-center gap-2 rounded-md px-2 ${place.kind === "branch" ? "bg-selected" : "hover:bg-hover"}`}
        >
          <PlusIcon className="size-3.5 shrink-0 text-kumo-subtle" />
          <input
            role="radio"
            aria-checked={place.kind === "branch"}
            aria-label="New branch"
            value={branch}
            placeholder="New branch in a new worktree…"
            spellCheck={false}
            onFocus={() => onChange({ kind: "branch", branch })}
            onChange={(event) => {
              setBranch(event.target.value);
              onChange({ kind: "branch", branch: event.target.value });
            }}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-kumo-subtle"
          />
        </div>
      </div>
    </Field>
  );
}
