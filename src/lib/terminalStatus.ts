import type { SessionStatus } from "./types";

/**
 * Every TUI animates a spinner while it works and falls silent when it is done,
 * so a gap this long means the turn ended. cursor-agent and opencode repaint
 * several times a second while busy.
 */
export const QUIET_AFTER = 1500;
/**
 * A turn keeps its spinner turning; one repaint is a toast coming or going, a
 * clock ticking over. Output has to keep coming this long to count as work.
 */
export const SUSTAIN = 700;
/** Output further apart than this is two separate bursts, not one that lasts. */
const BURST_GAP = 1000;
/** Keys the CLI echoes back are the user typing, not the agent working. */
export const ECHO_WINDOW = 300;
/**
 * A tab switch or a resize makes every TUI repaint, and losing focus makes
 * Claude and cursor-agent redraw their prompt: that burst is the switch
 * echoing back, not work.
 */
export const SETTLE_WINDOW = 1000;

/** The mark Claude leaves on the title while it waits for you. */
const CLAUDE_IDLE = "✳";
/** The marks Claude turns through the title while a turn runs. */
const CLAUDE_BUSY = /^[◐◓◑◒⠀-⣿]$/u;

/**
 * Busy, idle, or nothing to say, read off the terminal title. Claude Code titles
 * its terminal `✳ <name>` at rest and spins `◐ <name>` while it works. It is the
 * one signal that says so outright: a long tool call keeps the title spinning
 * while nothing else on screen needs to move.
 */
export function titleBusy(title: string): boolean | null {
  const [mark] = title;
  if (!mark || title.charAt(mark.length) !== " ") return null;
  if (mark === CLAUDE_IDLE) return false;
  return CLAUDE_BUSY.test(mark) ? true : null;
}

/**
 * The title without Claude's mark: what changes when a CLI renames its session.
 * Claude, opencode and cursor-agent all put the session's name in the title.
 */
export function titleName(title: string): string {
  const [mark] = title;
  return mark && titleBusy(title) !== null ? title.slice(mark.length + 1) : title;
}

export type Clock = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Options = {
  report: (status: SessionStatus) => void;
  /** Whether the process still has something running, for the close prompt. */
  onBusy?: (busy: boolean) => void;
  clock?: Clock;
};

/**
 * What a terminal session's indicator says, from what its process does.
 *
 * - `working` while the CLI is busy, looked at or not, as an agent chat does.
 * - `done` once it finishes while you are elsewhere; `idle` when you watched.
 * - `needs-input` when it rings for you from the background.
 *
 * Busy comes from the title where the CLI states it (Claude), and from output
 * otherwise: output that keeps coming means it is going, silence after it means
 * it finished. Output that only answers the user never starts a turn: a key
 * echoed, a repaint after a tab switch or a resize, the screen a CLI draws when
 * it starts or resumes, or a lone repaint such as a toast.
 */
export class TerminalActivity {
  #status: SessionStatus;
  #busy = false;
  #watched: boolean;
  /** The CLI titles its own state, so output stops deciding. */
  #titled = false;
  /** Drawing its first screen; over at the first pause, key, or title. */
  #starting = true;
  #lastInput = Number.NEGATIVE_INFINITY;
  #burstStart = Number.NEGATIVE_INFINITY;
  #lastOutput = Number.NEGATIVE_INFINITY;
  #settleUntil = Number.NEGATIVE_INFINITY;
  #quiet: unknown = null;
  readonly #report: (status: SessionStatus) => void;
  readonly #onBusy: (busy: boolean) => void;
  readonly #clock: Clock;

  constructor(initial: SessionStatus, watched: boolean, { report, onBusy = () => {}, clock = REAL_CLOCK }: Options) {
    this.#status = initial;
    this.#watched = watched;
    this.#report = report;
    this.#onBusy = onBusy;
    this.#clock = clock;
    // Nothing runs before the process spawns: a stored `working` is left over
    // from a window that closed mid-turn, and a watched tab has been read.
    if (initial === "working" || (watched && initial !== "error")) this.#push("idle");
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get busy(): boolean {
    return this.#busy;
  }

  setWatched(watched: boolean): void {
    if (watched === this.#watched) return;
    this.#watched = watched;
    this.settle();
    if (watched) this.#push(this.#busy ? "working" : "idle");
  }

  /** The user typed, pasted, clicked or focused: what comes back is an echo. */
  input(): void {
    this.#lastInput = this.#clock.now();
    this.#starting = false;
  }

  /** The grid changed or the tab moved; the repaint that follows is not work. */
  settle(): void {
    this.#settleUntil = this.#clock.now() + SETTLE_WINDOW;
  }

  output(): void {
    if (this.#titled) return;
    if (this.#starting) {
      this.#armQuiet(() => {
        this.#starting = false;
      });
      return;
    }
    const now = this.#clock.now();
    const gap = now - this.#lastOutput;
    this.#lastOutput = now;
    if (!this.#busy) {
      if (now - this.#lastInput < ECHO_WINDOW) {
        this.#burstStart = Number.NEGATIVE_INFINITY;
        return;
      }
      // A switch's repaint starts nothing, but a spinner that was already
      // turning keeps its count through it.
      const fresh = gap > BURST_GAP || this.#burstStart === Number.NEGATIVE_INFINITY;
      if (fresh && now < this.#settleUntil) {
        this.#burstStart = Number.NEGATIVE_INFINITY;
        return;
      }
      if (fresh) this.#burstStart = now;
      if (now - this.#burstStart < SUSTAIN) return;
      this.#setBusy(true);
    }
    this.#armQuiet(() => this.#setBusy(false));
  }

  title(title: string): void {
    const busy = titleBusy(title);
    if (busy === null) return;
    this.#titled = true;
    this.#starting = false;
    this.#stopQuiet();
    this.#setBusy(busy);
  }

  bell(): void {
    // Waiting on you is still running: the process is alive behind the prompt.
    this.#onBusy(true);
    if (!this.#watched) this.#push("needs-input");
  }

  /** The process ended; the shell that replaces it starts over. */
  exit(code: number | null): void {
    this.#stopQuiet();
    this.#titled = false;
    this.#starting = true;
    this.#busy = false;
    this.#onBusy(false);
    if (code !== 0 && code !== null) this.#push("error");
    else this.#push(this.#watched ? "idle" : "done");
  }

  dispose(): void {
    this.#stopQuiet();
    this.#onBusy(false);
  }

  #setBusy(busy: boolean): void {
    const was = this.#busy;
    this.#busy = busy;
    this.#onBusy(busy);
    if (busy === was) return;
    if (busy) {
      // A bell already claimed the slot and the redraw that follows is not new
      // work; a title that spins again is: the question was answered.
      if (this.#status !== "needs-input" || this.#titled) this.#push("working");
      return;
    }
    if (this.#watched) this.#push("idle");
    else if (this.#status === "working") this.#push("done");
  }

  #armQuiet(run: () => void): void {
    this.#stopQuiet();
    this.#quiet = this.#clock.setTimeout(() => {
      this.#quiet = null;
      run();
    }, QUIET_AFTER);
  }

  #stopQuiet(): void {
    if (this.#quiet !== null) this.#clock.clearTimeout(this.#quiet);
    this.#quiet = null;
  }

  #push(status: SessionStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#report(status);
  }
}
