import { CheckIcon, ChevronRightIcon, LoaderCircleIcon, MinusIcon, PlayIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BotPicker } from "../chrome/BotPicker";
import { Button, Card, Field, IconButton, TextArea, TextInput, Toggle } from "../chrome/kit";
import { RoutineTrigger } from "../chrome/RoutineTrigger";
import * as api from "../lib/api";
import { isValidCron } from "../lib/cron";
import { type RoutineDraft, type RoutineRun } from "../lib/routines";
import { dayLabel, duration } from "../lib/time";
import type { Workspace } from "../lib/types";

type Props = {
  initial: RoutineDraft;
  initialWorkspaceId: string;
  workspaces: Workspace[];
  /** The live run history; the draft's copy goes stale while the editor is open. */
  runs: RoutineRun[];
  onSave: (draft: RoutineDraft) => Promise<void>;
  onDelete: (() => void) | null;
  onRunNow: (() => Promise<void>) | null;
  onBack: () => void;
};

/** One routine, full screen: what it is, who runs it, when, and what it did. */
export function RoutineEditor({
  initial,
  initialWorkspaceId,
  workspaces,
  runs,
  onSave,
  onDelete,
  onRunNow,
  onBack,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listSessions(workspaceId)
      .then((list) => {
        if (cancelled) return;
        const found = list.filter((session) => session.kind === "bot");
        // Moving the routine to another workspace hands it to that workspace's first bot.
        setDraft((prev) =>
          found.some((bot) => bot.id === prev.sessionId)
            ? prev
            : { ...prev, sessionId: found[0]?.id ?? "" },
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const cronOk = draft.schedule.kind !== "cron" || isValidCron(draft.schedule.expression);
  const valid = draft.name.trim() !== "" && draft.prompt.trim() !== "" && draft.sessionId !== "" && cronOk;

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  async function run() {
    if (!onRunNow || running) return;
    setRunning(true);
    setRunError(null);
    try {
      await onRunNow();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-md px-1.5 py-0.5 text-icon transition-colors hover:bg-hover hover:text-text"
          >
            Routines
          </button>
          <ChevronRightIcon className="size-3 text-placeholder" />
          <span className="min-w-0 truncate">{draft.name.trim() || "New routine"}</span>
          <span className="flex-1" />
          {onRunNow && (
            <Button icon={PlayIcon} loading={running} onClick={() => void run()}>
              Run now
            </Button>
          )}
          <Button variant="primary" disabled={!valid} loading={saving} onClick={() => void save()}>
            Save
          </Button>
          {onDelete && <IconButton icon={Trash2Icon} label="Delete routine" onClick={onDelete} />}
        </div>

        {runError && (
          <p className="text-[13px] text-danger" role="alert">
            {runError}
          </p>
        )}

        <div className="flex flex-col gap-6">
          <Field label="Title">
            <TextInput
              autoFocus
              value={draft.name}
              placeholder="e.g. Morning digest"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>

          <Group label="Triggers">
            <RoutineTrigger
              schedule={draft.schedule}
              onChange={(schedule) => setDraft({ ...draft, schedule })}
            />
          </Group>

          <Field label="Instructions">
            <TextArea
              rows={10}
              value={draft.prompt}
              placeholder="What the bot should do each run"
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </Field>

          <Group label="Runs as">
            <BotPicker
              workspaces={workspaces}
              workspaceId={workspaceId}
              sessionId={draft.sessionId}
              onChange={(nextWorkspaceId, sessionId) => {
                setWorkspaceId(nextWorkspaceId);
                setDraft((prev) => ({ ...prev, sessionId }));
              }}
            />
          </Group>

          <Card>
            <Toggle
              label="Enabled"
              description="Off pauses the schedule. Run now still works."
              checked={draft.enabled}
              onChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </Card>

          {runs.length > 0 && <History runs={runs} />}
        </div>
      </div>
    </div>
  );
}

/** A label over something that is not one control; Field's <label> would forward clicks into it. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function History({ runs }: { runs: RoutineRun[] }) {
  return (
    <Group label="Run history">
      <ul className="flex flex-col rounded-xl bg-card px-4 [&>*+*]:border-t [&>*+*]:border-hairline">
        {runs.map((run) => (
          <li key={run.id} className="flex h-9 items-center gap-2.5">
            <RunMark run={run} />
            <span className="min-w-0 flex-1 truncate">{dayLabel(run.startedAt)}</span>
            {run.trigger === "manual" && <span className="shrink-0 text-placeholder">manual</span>}
            {run.finishedAt !== null && (
              <span className="shrink-0 text-text-muted tabular-nums">
                {duration(run.finishedAt - run.startedAt)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Group>
  );
}

function RunMark({ run }: { run: RoutineRun }) {
  if (run.status === "running")
    return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-warning" />;
  if (run.status === "ok") return <CheckIcon className="size-3.5 shrink-0 text-success" />;
  // Came due while the bot was busy: nothing ran, and nothing went wrong.
  if (run.status === "skipped") return <MinusIcon className="size-3.5 shrink-0 text-placeholder" />;
  return <XIcon className="size-3.5 shrink-0 text-danger" />;
}
