import { Button, Input, InputArea, Label, Select, Switch } from "@cloudflare/kumo";
import {
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  PlayIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { RoutineTrigger } from "../chrome/RoutineTrigger";
import * as api from "../lib/api";
import { isValidCron } from "../lib/cron";
import { type RoutineDraft, type RoutineRun } from "../lib/routines";
import { dayLabel, duration } from "../lib/time";
import type { Session, Workspace } from "../lib/types";

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
  const [agents, setAgents] = useState<Session[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listSessions(workspaceId)
      .then((list) => {
        if (cancelled) return;
        const found = list.filter((session) => session.kind === "agent");
        setAgents(found);
        // Moving the routine to another workspace hands it to that workspace's first agent.
        setDraft((prev) =>
          found.some((agent) => agent.id === prev.sessionId)
            ? prev
            : { ...prev, sessionId: found[0]?.id ?? "" },
        );
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
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
    try {
      await onRunNow();
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
            className="rounded-md px-1.5 py-0.5 text-kumo-subtle transition-colors hover:bg-hover hover:text-kumo-default"
          >
            Routines
          </button>
          <CaretRightIcon className="size-3 text-placeholder" />
          <span className="min-w-0 truncate">{draft.name.trim() || "New routine"}</span>
          <span className="flex-1" />
          {onRunNow && (
            <Button variant="secondary" size="sm" icon={PlayIcon} loading={running} onClick={() => void run()}>
              Run now
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!valid} loading={saving} onClick={() => void save()}>
            Save
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<TrashIcon className="size-4" />}
              aria-label="Delete routine"
              onClick={onDelete}
            />
          )}
        </div>

        <div className="flex flex-col gap-6">
          <Input
            autoFocus
            label="Title"
            className="w-full"
            value={draft.name}
            placeholder="e.g. Morning digest"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />

          <div className="flex flex-col gap-1.5">
            <Label>Triggers</Label>
            <RoutineTrigger
              schedule={draft.schedule}
              onChange={(schedule) => setDraft({ ...draft, schedule })}
            />
          </div>

          <InputArea
            label="Instructions"
            className="w-full"
            rows={10}
            value={draft.prompt}
            placeholder="What the agent should do every time this routine fires."
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          />

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Workspace</Label>
              <Select
                aria-label="Workspace"
                size="sm"
                value={workspaceId}
                onValueChange={(value) => value && setWorkspaceId(value)}
                items={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Agent</Label>
              <Select
                aria-label="Agent"
                size="sm"
                disabled={agents.length === 0}
                value={draft.sessionId}
                onValueChange={(value) => value && setDraft({ ...draft, sessionId: value })}
                items={
                  agents.length === 0
                    ? [{ value: "", label: "No agents in this workspace" }]
                    : agents.map((agent) => ({ value: agent.id, label: agent.name }))
                }
              />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-sidebar p-3">
            <Switch
              variant="neutral"
              controlFirst={false}
              // kumo lays the labelled switch out as [auto, 1fr]; without this the
              // control sits against the label instead of the card's edge.
              className="justify-self-end"
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              label={
                <span className="block">
                  <span className="block font-medium">Enabled</span>
                  <span className="mt-0.5 block font-normal text-kumo-subtle">
                    Off keeps the routine but stops the schedule. Run now still works
                  </span>
                </span>
              }
            />
          </div>

          {runs.length > 0 && <History runs={runs} />}
        </div>
      </div>
    </div>
  );
}

function History({ runs }: { runs: RoutineRun[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Run history</Label>
      <ul className="flex flex-col rounded-xl border border-border bg-sidebar">
        {runs.map((run) => (
          <li
            key={run.id}
            className="flex items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0"
          >
            <RunMark run={run} />
            <span className="min-w-0 flex-1 truncate">{dayLabel(run.startedAt)}</span>
            {run.trigger === "manual" && <span className="shrink-0 text-placeholder">manual</span>}
            {run.finishedAt !== null && (
              <span className="shrink-0 text-kumo-subtle tabular-nums">
                {duration(run.finishedAt - run.startedAt)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunMark({ run }: { run: RoutineRun }) {
  if (run.status === "running")
    return <CircleNotchIcon className="size-3.5 shrink-0 animate-spin text-kumo-warning" weight="bold" />;
  if (run.status === "ok") return <CheckIcon className="size-3.5 shrink-0 text-kumo-success" weight="bold" />;
  return <XIcon className="size-3.5 shrink-0 text-danger" weight="bold" />;
}
