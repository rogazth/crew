import type { MachineSync, SyncState } from "./reconciler";

const names = (machines: MachineSync[], state: SyncState) =>
  machines.filter((machine) => machine.state === state).map((machine) => machine.name).join(", ");

/** One line on where the machines stand; nothing with no other machine to agree with. */
export function syncLine(machines: MachineSync[]): string | undefined {
  if (machines.length === 0) return undefined;
  const failed = names(machines, "failed");
  if (failed) return `Could not update ${failed}. Trying again.`;
  const outdated = names(machines, "outdated");
  if (outdated) return `${outdated} needs a Crew update to get these settings.`;
  const offline = names(machines, "offline");
  if (offline) return `Waiting for ${offline} to come online.`;
  if (machines.some((machine) => machine.state === "syncing")) return "Syncing to your machines.";
  return "Synced across your machines.";
}
