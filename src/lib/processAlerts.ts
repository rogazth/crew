import * as api from "./api";
import { client } from "./client";
import { dispatchNotification } from "./notifications";
import type { Process, ProcessRun, ProcessState } from "./protocol";

/**
 * A command that fails on its own is news: one that exits with an error, or
 * one auto-restart gave up on. A stop by hand ends `stopped`, a clean exit
 * `exited` with code 0; neither is.
 */
export function crashNews(prev: ProcessState | undefined, run: Pick<ProcessRun, "state" | "exitCode">): string | null {
  if (prev === undefined || prev === run.state) return null;
  if (run.state === "crashed") return "Kept crashing, and was left stopped";
  if (run.state !== "exited" || run.exitCode === 0) return null;
  return run.exitCode === null ? "Was killed by a signal" : `Exited with code ${run.exitCode}`;
}

/** The state each run was last seen in, by process and worktree. */
const states = new Map<string, ProcessState>();
const seeded = new Set<string>();
let booted = false;

const runKey = (process: Process, run: ProcessRun) => `${process.id}\0${run.worktree ?? ""}`;

function hear(process: Process) {
  for (const run of process.runs) {
    const key = runKey(process, run);
    const news = crashNews(states.get(key), run);
    states.set(key, run.state);
    if (!news) continue;
    void dispatchNotification({
      source: "process",
      title: process.name,
      body: run.worktree ? `${news} in ${run.worktree.split("/").pop()}` : news,
      key: `process:${key}`,
    });
  }
}

/**
 * Watches every workspace's commands. Each one's runs are read once first, so
 * a server that was up before the window opened is known to be up when it
 * falls over.
 */
export function watchProcesses(workspaceIds: readonly string[]): void {
  if (!booted) {
    booted = true;
    client.on("process-changed", (payload) => hear(payload as Process));
  }
  for (const id of workspaceIds) {
    if (seeded.has(id)) continue;
    seeded.add(id);
    void api
      .listProcesses(id)
      .then((list) => {
        for (const process of list) {
          for (const run of process.runs) {
            const key = runKey(process, run);
            if (!states.has(key)) states.set(key, run.state);
          }
        }
      })
      .catch(() => seeded.delete(id));
  }
}
