import { useEffect, useId, useRef, useState } from "react";
import { dayLabel, duration } from "@crew/fixtures";
import type { Routine, RoutineRun } from "@crew/fixtures";
import { TriggerControl } from "@/chrome/TriggerControl";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useApp } from "@/lib/store";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  IconButton,
  Input,
  Menu,
  MenuItem,
  ProviderMark,
  Pulse,
  ScrollArea,
  Select,
  SettingRow,
  Switch,
  Textarea,
} from "@/ui";

function RunMark({ status }: { status: RoutineRun["status"] }) {
  switch (status) {
    case "running":
      return <Pulse label="Running" />;
    case "ok":
      return <Icon name="check" size={14} className="text-[var(--status-success)]" />;
    case "skipped":
      return <Icon name="minus" size={14} className="text-quaternary" />;
    case "error":
      return <Icon name="close" size={14} className="text-[var(--status-danger)]" />;
  }
}

function RunRow({ run }: { run: RoutineRun }) {
  const span =
    run.finishedAt === null
      ? "running"
      : // A skipped run opens and closes on the same tick; "1s" would be a lie.
        run.finishedAt === run.startedAt
        ? "—"
        : duration(run.finishedAt - run.startedAt);

  return (
    <div className="flex items-center gap-2.5 px-3.5 py-2">
      <span className="flex size-4 shrink-0 items-center justify-center">
        <RunMark status={run.status} />
      </span>
      <span className="min-w-0 truncate text-body text-secondary">{dayLabel(run.startedAt)}</span>
      {run.trigger === "manual" && <Badge>manual</Badge>}
      <span
        className={cx(
          "ml-auto shrink-0 text-small tnum",
          run.finishedAt === null ? "text-[var(--status-attention)]" : "text-tertiary",
        )}
      >
        {span}
      </span>
    </div>
  );
}

export function RoutineEditor({ routine }: { routine: Routine }) {
  const { sessions, workspaces, activeWorkspaceId, actions } = useApp();
  const titleId = useId();
  const promptId = useId();

  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const owner = sessions.find((s) => s.id === routine.sessionId);
  const workspaceId = owner?.workspaceId ?? activeWorkspaceId;
  const agents = sessions.filter((s) => s.kind === "agent" && s.workspaceId === workspaceId);
  const agentWorkspaces = workspaces.filter((w) =>
    sessions.some((s) => s.kind === "agent" && s.workspaceId === w.id),
  );

  const patch = (next: Partial<Routine>) => actions.updateRoutine(routine.id, next);

  // Every field writes through on change, so Save has nothing left to commit; it
  // exists because the user expects it, and it confirms rather than persists.
  const save = () => {
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1200);
  };

  const askDelete = () => {
    actions.confirm({
      title: `Delete ${routine.name}?`,
      description: "The routine and its run history go with it. This cannot be undone.",
      confirmLabel: "Delete routine",
      destructive: true,
      onConfirm: () => actions.deleteRoutine(routine.id),
    });
  };

  const runs = routine.runs.slice().sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-body">
          <button
            type="button"
            onClick={() => actions.openRoutines(null)}
            className="rounded-sm px-1 text-tertiary transition-colors duration-[var(--dur-2)] hover:text-primary"
          >
            Routines
          </button>
          <span aria-hidden className="text-quaternary">
            /
          </span>
          <span className="min-w-0 truncate text-primary">{routine.name}</span>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button icon="play" onClick={() => actions.runRoutine(routine.id)}>
            Run now
          </Button>
          <Button tone="primary" onClick={save} className="min-w-[84px]">
            <Icon
              name="check"
              size={14}
              className={cx(
                "-ml-0.5 mr-1.5 shrink-0 transition-opacity duration-[var(--dur-2)]",
                saved ? "opacity-100" : "opacity-0",
              )}
            />
            {saved ? "Saved" : "Save"}
          </Button>
          <Menu align="end" trigger={<IconButton icon="ellipsis" label="Routine actions" />}>
            <MenuItem destructive icon="trash" onClick={askDelete}>
              Delete routine
            </MenuItem>
          </Menu>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
          <Field label="Title" htmlFor={titleId}>
            <Input
              id={titleId}
              value={routine.name}
              onChange={(event) => patch({ name: event.target.value })}
              className="max-w-sm"
            />
          </Field>

          <Field label="Triggers">
            <TriggerControl value={routine.schedule} onChange={(schedule) => patch({ schedule })} />
          </Field>

          <Field
            label="Instructions"
            htmlFor={promptId}
            hint="What the agent is told, every time the routine fires."
          >
            <Textarea
              id={promptId}
              rows={10}
              value={routine.prompt}
              placeholder="Read last night's CI failures and file the real ones…"
              onChange={(event) => patch({ prompt: event.target.value })}
            />
          </Field>

          <Field label="Workspace">
            <Select
              value={workspaceId}
              onValueChange={(next) => {
                const first = sessions.find((s) => s.kind === "agent" && s.workspaceId === next);
                if (first) patch({ sessionId: first.id });
              }}
              options={agentWorkspaces.map((w) => ({ value: w.id, label: w.name }))}
              width={280}
            />
          </Field>

          <Field label="Agent">
            <Select
              value={routine.sessionId}
              onValueChange={(sessionId) => patch({ sessionId })}
              options={agents.map((s) => ({
                value: s.id,
                label: s.name,
                note: s.model,
              }))}
              width={280}
              placeholder="Pick an agent…"
              renderValue={(option) => {
                const session = sessions.find((s) => s.id === option?.value);
                if (!session) return <span className="text-quaternary">Pick an agent…</span>;
                return (
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderMark provider={session.provider} size={16} />
                    <span className="min-w-0 truncate">{session.name}</span>
                  </span>
                );
              }}
            />
          </Field>

          <Card>
            <SettingRow
              label="Enabled"
              description="A paused routine keeps its schedule but never fires."
              control={
                <Switch
                  checked={routine.enabled}
                  onCheckedChange={(enabled) => patch({ enabled })}
                />
              }
            />
          </Card>

          <Card title="Run history">
            {runs.length === 0 ? (
              <Empty
                icon="clock"
                title="No runs yet"
                description="Runs land here once the schedule fires — or when you press Run now."
              />
            ) : (
              runs.map((run) => <RunRow key={run.id} run={run} />)
            )}
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
