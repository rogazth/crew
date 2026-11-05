import { expect, test } from "vitest";
import type { MachineSync, SyncState } from "./reconciler";
import { syncLine } from "./syncLine";

const machine = (name: string, state: SyncState): MachineSync => ({ id: name, name, state });

test("says nothing with no other machine", () => {
  expect(syncLine([])).toBeUndefined();
});

test("names who is waited on, and leaves out who is not", () => {
  expect(syncLine([machine("falcon-heavy", "synced"), machine("devbox", "offline")])).toBe("Waiting for devbox to come online.");
});

test("a failure outranks waiting", () => {
  expect(syncLine([machine("falcon-heavy", "failed"), machine("devbox", "offline")])).toBe(
    "Could not update falcon-heavy. Trying again.",
  );
});

test("says nothing while they agree or are on their way to", () => {
  expect(syncLine([machine("falcon-heavy", "synced"), machine("devbox", "syncing")])).toBeUndefined();
});
