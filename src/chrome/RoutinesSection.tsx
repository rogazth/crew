import { Button, InputArea, Switch } from "@cloudflare/kumo";
import { CheckIcon, CircleNotchIcon, ClockIcon, PauseCircleIcon, PlusIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  CADENCES,
  cadenceOf,
  describeSchedule,
  newRoutineDraft,
  type RoutineDraft,
  type RoutineRun,
  type Schedule,
} from "../lib/routines";
import { dayLabel } from "../lib/time";

type Props = {
  routines: RoutineDraft[];
  onChange: (routines: RoutineDraft[]) => void;
  /** Saved routines can run from here; unsaved ones need the sheet's Save first. */
  onRunNow?: (routine: RoutineDraft) => Promise<void>;
};

const FIELD =
  "h-8 rounded-md bg-kumo-control px-2 text-kumo-default ring ring-kumo-line outline-none focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50";

/** Standing orders for this agent: a list, one open editor, the last few runs. */
export function RoutinesSection({ routines, onChange, onRunNow }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const update = (index: number, next: RoutineDraft) =>
    onChange(routines.map((routine, i) => (i === index ? next : routine)));

  const add = () => {
    onChange([...routines, newRoutineDraft()]);
    setOpen(routines.length);
  };

  const remove = (index: number) => {
    onChange(routines.filter((_, i) => i !== index));
    setOpen(null);
  };

  const runNow = async (routine: RoutineDraft) => {
    if (!onRunNow || running) return;
    setRunning(true);
    try {
      await onRunNow(routine);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-sidebar">
      <div className="flex h-10 items-center justify-between pr-1.5 pl-3">
        <span className="font-medium">Routines</span>
        <Button variant="ghost" size="sm" icon={PlusIcon} onClick={add}>
          Add
        </Button>
      </div>
      {routines.length === 0 ? (
        <p className="px-3 pb-3 text-kumo-subtle">Recurring tasks this agent runs on a schedule, inside this conversation.</p>
      ) : (
        <ul className="flex flex-col border-t border-border">
          {routines.map((routine, index) => (
            <li key={routine.key} className="border-b border-border last:border-b-0">
              {open === index ? (
                <Editor
                  routine={routine}
                  running={running}
                  onChange={(next) => update(index, next)}
                  onClose={() => setOpen(null)}
                  onRemove={() => remove(index)}
                  {...(onRunNow && routine.id ? { onRunNow: () => void runNow(routine) } : {})}
                />
              ) : (
                <Row routine={routine} onOpen={() => setOpen(index)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ routine, onOpen }: { routine: RoutineDraft; onOpen: () => void }) {
  const last = routine.runs[0];
  const Icon = !routine.enabled ? PauseCircleIcon : last?.status === "running" ? CircleNotchIcon : ClockIcon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover"
    >
      <Icon className={`size-4 shrink-0 text-kumo-subtle ${last?.status === "running" && routine.enabled ? "animate-spin" : ""}`} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{routine.name.trim() || "Untitled routine"}</span>
        <span className="truncate text-[12px] leading-4 text-kumo-subtle">
          {routine.enabled ? describeSchedule(routine.schedule) : "Paused"}
        </span>
      </span>
      {last && <RunMark run={last} />}
    </button>
  );
}

function RunMark({ run }: { run: RoutineRun }) {
  if (run.status === "running") return <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />;
  if (run.status === "ok") return <CheckIcon className="size-3.5 text-kumo-success" weight="bold" />;
  return <XIcon className="size-3.5 text-danger" weight="bold" />;
}

function Editor({
  routine,
  running,
  onChange,
  onClose,
  onRemove,
  onRunNow,
}: {
  routine: RoutineDraft;
  running: boolean;
  onChange: (routine: RoutineDraft) => void;
  onClose: () => void;
  onRemove: () => void;
  onRunNow?: () => void;
}) {
  const schedule = routine.schedule;
  const time =
    schedule.kind === "daily"
      ? `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`
      : "";

  const pickCadence = (id: string) => {
    const base = CADENCES.find((c) => c.id === id)?.schedule ?? CADENCES[3]!.schedule;
    const next: Schedule =
      base.kind === "daily" && schedule.kind === "daily"
        ? { ...base, hour: schedule.hour, minute: schedule.minute }
        : base;
    onChange({ ...routine, schedule: next });
  };

  const pickTime = (value: string) => {
    if (schedule.kind !== "daily") return;
    const [h, m] = value.split(":").map(Number);
    if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return;
    onChange({ ...routine, schedule: { ...schedule, hour: h, minute: m } });
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <Switch
          variant="neutral"
          checked={routine.enabled}
          onCheckedChange={(checked) => onChange({ ...routine, enabled: checked })}
          label="Active"
        />
        <div className="flex items-center gap-1">
          {onRunNow && (
            <Button variant="secondary" size="sm" loading={running} onClick={onRunNow}>
              Test run
            </Button>
          )}
          <Button variant="ghost" size="sm" shape="square" icon={<TrashIcon className="size-4" />} aria-label="Delete routine" onClick={onRemove} />
          <Button variant="ghost" size="sm" shape="square" icon={<XIcon className="size-4" />} aria-label="Done" onClick={onClose} />
        </div>
      </div>
      <input
        autoFocus
        aria-label="Name"
        value={routine.name}
        placeholder="Name this routine"
        onChange={(event) => onChange({ ...routine, name: event.target.value })}
        className={`${FIELD} w-full`}
      />
      <InputArea
        aria-label="Instruction"
        className="w-full"
        rows={3}
        value={routine.prompt}
        placeholder="What should this routine do each time it runs?"
        onChange={(event) => onChange({ ...routine, prompt: event.target.value })}
      />
      <div className="flex gap-2">
        <select
          aria-label="When to run"
          value={cadenceOf(schedule)}
          onChange={(event) => pickCadence(event.target.value)}
          className={`${FIELD} min-w-0 flex-1`}
        >
          {CADENCES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        {schedule.kind === "daily" && (
          <input
            type="time"
            aria-label="Time"
            value={time}
            onChange={(event) => pickTime(event.target.value)}
            className={`${FIELD} w-[124px] tabular-nums`}
          />
        )}
      </div>
      {routine.runs.length > 0 && (
        <ul aria-label="Run history" className="flex flex-col gap-1 text-[12px] leading-4 text-kumo-subtle">
          {routine.runs.slice(0, 5).map((run) => (
            <li key={run.id} className="flex items-center gap-2">
              <RunMark run={run} />
              <span>{dayLabel(run.startedAt)}</span>
              {run.trigger === "manual" && <span className="text-placeholder">test run</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
