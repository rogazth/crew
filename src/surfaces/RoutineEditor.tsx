import { Menu } from "@base-ui/react/menu";
import { BotIcon, EllipsisIcon, LoaderCircleIcon, PlayIcon, PowerIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { BotPicker } from "../chrome/BotPicker";
import { CardHead, PaneCard, PaneRow, PaneSentence } from "../chrome/BotPaneParts";
import { Button, IconButton, PANEL, ROW, Switch, usePageTrail } from "../chrome/kit";
import { RunMark } from "../chrome/RoutineCard";
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
  // Where it is goes in the strip above the sheet, as Settings says where it is.
  usePageTrail([{ label: "Routines", onClick: onBack }, draft.name.trim() || "New routine"]);

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
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* PageFrame's measure, so the name sits where the Routines title was. */}
        <div className="mx-auto flex max-w-[720px] flex-col gap-7 px-10 pt-12 pb-8">
          <header className="flex items-center gap-4 px-1">
            {/* The name is the page's title, typed in place: no box, nothing that shifts as it is edited. */}
            <input
              autoFocus={!draft.name}
              spellCheck={false}
              aria-label="Name"
              value={draft.name}
              placeholder="Routine name"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="h-7 min-w-0 flex-1 truncate bg-transparent text-[22px] leading-7 font-semibold tracking-[-0.02em] outline-none placeholder:text-placeholder"
            />
            {(onRunNow || onDelete) && (
              <Menu.Root modal={false}>
                <Menu.Trigger
                  render={
                    <IconButton
                      icon={running ? LoaderCircleIcon : EllipsisIcon}
                      label="More actions"
                      className={`data-popup-open:bg-hover data-popup-open:text-text ${running ? "[&_svg]:animate-spin" : ""}`}
                    />
                  }
                />
                <Menu.Portal>
                  <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
                    <Menu.Popup className={PANEL}>
                      {onRunNow && (
                        <Menu.Item className={ROW} disabled={running} onClick={() => void run()}>
                          <PlayIcon className="size-4 shrink-0 text-icon" />
                          <span className="min-w-0 flex-1 truncate">Run now</span>
                        </Menu.Item>
                      )}
                      {onDelete && (
                        <Menu.Item className={`${ROW} text-danger data-highlighted:bg-danger/10`} onClick={onDelete}>
                          <Trash2Icon className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">Delete routine</span>
                        </Menu.Item>
                      )}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            )}
          </header>

          {runError && (
            <p className="-mt-4 px-1 text-[13px] text-danger" role="alert">
              {runError}
            </p>
          )}

          <div className="flex flex-col gap-3">
            <PaneCard label="Instructions">
              <textarea
                aria-label="Instructions"
                value={draft.prompt}
                placeholder="What it does each run, as you would ask it in a message."
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                className="block min-h-[152px] w-full resize-none bg-transparent py-3 text-[13px] leading-[19px] outline-none [field-sizing:content] placeholder:text-placeholder"
              />
            </PaneCard>

            <PaneCard label="Bot">
              <PaneSentence icon={<BotIcon className="size-4" />} title="Bot">
                <BotPicker
                  workspaces={workspaces}
                  workspaceId={workspaceId}
                  sessionId={draft.sessionId}
                  onChange={(nextWorkspaceId, sessionId) => {
                    setWorkspaceId(nextWorkspaceId);
                    setDraft((prev) => ({ ...prev, sessionId }));
                  }}
                />
              </PaneSentence>
            </PaneCard>

            <RoutineTrigger schedule={draft.schedule} onChange={(schedule) => setDraft({ ...draft, schedule })} />

            <PaneCard label="Enabled">
              <PaneRow toggles icon={<PowerIcon className="size-4" />} title="Enabled">
                <Switch label="Enabled" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
              </PaneRow>
            </PaneCard>

            {runs.length > 0 && <History runs={runs} />}
          </div>
        </div>
      </div>
      {/* No rule over it: what scrolls fades into it. */}
      <div className="relative mx-auto flex w-full max-w-[720px] shrink-0 items-center justify-end gap-2 px-10 pt-1 pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-canvas before:to-transparent">
        <Button variant="ghost" onClick={onBack}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!valid} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function History({ runs }: { runs: RoutineRun[] }) {
  return (
    <PaneCard label="Run history">
      <CardHead title="Run history" aside={runs.length} />
      {runs.map((run) => (
        <div key={run.id} className="flex h-10 items-center gap-3">
          <span className="grid w-5 shrink-0 place-items-center">
            <RunMark run={run} />
          </span>
          <span className="min-w-0 flex-1 truncate">{dayLabel(run.startedAt)}</span>
          {run.trigger === "manual" && <span className="shrink-0 text-placeholder">manual</span>}
          {run.finishedAt !== null && <span className="shrink-0 text-text-muted tabular-nums">{duration(run.finishedAt - run.startedAt)}</span>}
        </div>
      ))}
    </PaneCard>
  );
}
