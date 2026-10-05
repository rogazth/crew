// PROTOTYPE — small derivations the views share: a background command's state, a pair's key.
import { elapsed } from "../../lib/time";
import type { Task } from "./store";

/** One thread per pair, whoever wrote first: the key is the two names, in order. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(" ⇄ ");
}

export function taskState(task: Task): string {
  if (task.state === "running") return `running ${elapsed(task.startedAt)}`;
  if (task.state === "stopped") return "stopped";
  return task.exitCode === 0 ? "exited 0" : `exited ${task.exitCode ?? "?"}`;
}
