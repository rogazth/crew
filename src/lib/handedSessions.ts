/**
 * Sessions handed to the user in this run (`start_session` with owner user). Their terminals start
 * out of sight, so the CLI is on the task before anyone opens its tab; every
 * other tab waits to be shown, so a relaunch does not start each saved one.
 */
const handed = new Set<string>();

export function markHanded(id: string) {
  handed.add(id);
}

export function isHanded(id: string): boolean {
  return handed.has(id);
}
