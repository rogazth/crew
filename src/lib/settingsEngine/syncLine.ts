import type { MachineSync, SyncState } from "./reconciler";

const names = (machines: MachineSync[], state: SyncState) =>
  machines.filter((machine) => machine.state === state).map((machine) => machine.name).join(", ");

/** One line on a machine that is behind; nothing while they agree, or are on their way to. */
export function syncLine(machines: MachineSync[]): string | undefined {
  const failed = names(machines, "failed");
  if (failed) return `Could not update ${failed}. Trying again.`;
  const outdated = names(machines, "outdated");
  if (outdated) return `${outdated} needs a Crew update to get these settings.`;
  const offline = names(machines, "offline");
  return offline ? `Waiting for ${offline} to come online.` : undefined;
}
