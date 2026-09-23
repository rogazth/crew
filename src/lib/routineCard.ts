import { describeSchedule, parseSchedule, summarize, type Routine } from "./routines";

export type RoutineFace = {
  title: string;
  description: string;
  schedule: string;
  paused: boolean;
  /** Only an enabled routine warns; a paused one says Paused and nothing more. */
  failed: boolean;
};

/** What a routine's card says: its name, the prompt's opening, when it fires, and how its last run went. */
export function routineFace(routine: Pick<Routine, "name" | "prompt" | "schedule" | "enabled" | "runs">): RoutineFace {
  return {
    title: routine.name || "Untitled routine",
    description: summarize(routine.prompt),
    schedule: describeSchedule(parseSchedule(routine.schedule)),
    paused: !routine.enabled,
    failed: routine.enabled && routine.runs[0]?.status === "error",
  };
}
