/**
 * What a frame does with a terminal that has not settled its grid.
 *
 * A hidden pane has no grid to measure. One the user has already had on
 * screen, or that was asked to start out of sight, starts at the terminal's
 * own grid, so leaving the tab does not leave the CLI unstarted. A restored
 * pane that has never been shown waits: a relaunch must not start every saved CLI.
 */
export type GridGate = {
  started: boolean;
  /** On screen at least once, or asked to start with no pane to measure. */
  revealed: boolean;
};

/** `start` is out of sight, at the terminal's own grid. `fit` measures the one on screen. */
export type GridStep = "start" | "fit" | "wait";

/** `visible` means the pane is on screen, measured or not. A hidden one has no grid. */
export function gridStep(gate: GridGate, visible: boolean): { gate: GridGate; step: GridStep } {
  if (!visible) {
    if (!gate.started && gate.revealed) return { gate: { started: true, revealed: true }, step: "start" };
    return { gate, step: "wait" };
  }
  return { gate: { started: gate.started, revealed: true }, step: "fit" };
}
