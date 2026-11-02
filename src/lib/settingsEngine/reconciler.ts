// Keeps the global settings the same on every daemon. Daemons do not talk to
// each other, so the window carries them. There is no queue of changes to lose:
// a pass compares what each machine holds and repairs the difference, so any
// pass fixes whatever an earlier one could not, a machine that was off included.
import type { SettingRow } from "../protocol";
import { missingFrom, newestRevision, toSeed, winners } from "./plan";

export const LOCAL_ENV = "local";
const EVERY_MS = 5 * 60 * 1000;
export const RETRY_MS = [5_000, 30_000, 120_000];
const REMOTE_TIMEOUT_MS = 6_000;
const LOCAL_TIMEOUT_MS = 30_000;

export type Machine = { id: string; name: string; status: "connecting" | "online" | "offline"; mismatch: boolean };

export type Deps = {
  request: <T>(method: string, params: object, env: string) => Promise<T>;
  /** The remotes the window knows, up or not. */
  machines: () => Machine[];
  /** The global settings this build knows, to settle the ones from before the engine. */
  keys: () => string[];
};

/** How a machine stands with the choices this one holds. */
export type SyncState = "synced" | "syncing" | "offline" | "failed" | "outdated";
export type MachineSync = { id: string; name: string; state: SyncState };

const ackKey = (id: string) => `settings:acked:${id}`;

function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error("The machine took too long to answer")), ms);
    work.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const isOutdated = (error: unknown) => error instanceof Error && error.message.startsWith("Unknown method");

export class Reconciler {
  private running = false;
  private again = false;
  private stopped = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private every: ReturnType<typeof setInterval> | null = null;
  private newest = 0;
  /** The newest revision each machine is known to hold, kept on this one so a restart still knows who is behind. */
  private readonly acked = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly outdated = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private snapshot: MachineSync[] = [];

  constructor(private readonly deps: Deps) {}

  start() {
    this.stopped = false;
    this.every ??= globalThis.setInterval(() => this.kick(), EVERY_MS);
    this.kick();
  }

  stop() {
    this.stopped = true;
    if (this.every !== null) globalThis.clearInterval(this.every);
    this.every = null;
    this.clearRetry();
  }

  /** Run a pass now, or right after the one in progress: it may have read before what changed. */
  kick() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.clearRetry();
    this.running = true;
    void this.pass()
      .then(
        () => this.failed.size > 0,
        () => true,
      )
      .then((failing) => {
        this.running = false;
        this.publish();
        if (this.again) {
          this.again = false;
          this.kick();
        } else if (failing) {
          this.scheduleRetry();
        } else {
          this.attempt = 0;
        }
      });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  read = (): MachineSync[] => this.snapshot;

  /** A machine came or went: its row changes without a pass. */
  publish() {
    const next = this.deps.machines().map((machine) => ({ id: machine.id, name: machine.name, state: this.stateOf(machine) }));
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private stateOf(machine: Machine): SyncState {
    if (machine.mismatch || this.outdated.has(machine.id)) return "outdated";
    if ((this.acked.get(machine.id) ?? 0) >= this.newest) return "synced";
    if (machine.status !== "online") return "offline";
    return this.failed.has(machine.id) ? "failed" : "syncing";
  }

  private scheduleRetry() {
    if (this.stopped || this.retry !== null) return;
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)] ?? EVERY_MS;
    this.attempt += 1;
    this.retry = globalThis.setTimeout(() => {
      this.retry = null;
      this.kick();
    }, wait);
  }

  private clearRetry() {
    if (this.retry !== null) globalThis.clearTimeout(this.retry);
    this.retry = null;
  }

  private list(env: string, ms: number) {
    return timed(this.deps.request<SettingRow[]>("settings_list", {}, env), ms);
  }

  private merge(env: string, rows: SettingRow[], ms: number) {
    return timed(this.deps.request<SettingRow[]>("settings_merge", { rows }, env), ms);
  }

  private async loadAcks(machines: Machine[]) {
    const unknown = machines.filter((machine) => !this.acked.has(machine.id));
    await Promise.all(
      unknown.map(async (machine) => {
        const raw = await this.deps.request<string | null>("state_get", { key: ackKey(machine.id) }, LOCAL_ENV);
        this.acked.set(machine.id, Number(raw) || 0);
      }),
    );
  }

  private noteFailure(id: string, error: unknown) {
    if (isOutdated(error)) this.outdated.add(id);
    else this.failed.add(id);
  }

  private async seed(local: SettingRow[], others: SettingRow[][]): Promise<SettingRow[]> {
    let rows = local;
    for (const key of toSeed(this.deps.keys(), local, others)) {
      const value = local.find((row) => row.key === key)?.value ?? null;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- few keys, once in a machine's life
      const row = await this.deps.request<SettingRow>("settings_set", { key, value, scope: "global" }, LOCAL_ENV);
      rows = [...rows.filter((held) => held.key !== key), row];
    }
    return rows;
  }

  private async pass(): Promise<void> {
    const machines = this.deps.machines();
    const reachable = machines.filter((machine) => machine.status === "online" && !machine.mismatch);
    await this.loadAcks(machines);
    this.failed.clear();
    this.outdated.clear();

    const listed = await this.list(LOCAL_ENV, LOCAL_TIMEOUT_MS);
    const copies = new Map<string, SettingRow[]>();
    await Promise.all(
      reachable.map(async (machine) => {
        try {
          copies.set(machine.id, await this.list(machine.id, REMOTE_TIMEOUT_MS));
        } catch (error) {
          this.noteFailure(machine.id, error);
        }
      }),
    );

    const local = await this.seed(listed, [...copies.values()]);
    const best = winners([local, ...copies.values()]);
    this.newest = newestRevision(best);

    await this.merge(LOCAL_ENV, missingFrom(local, best), LOCAL_TIMEOUT_MS);
    await Promise.all(
      [...copies].map(async ([id, copy]) => {
        try {
          await this.merge(id, missingFrom(copy, best), REMOTE_TIMEOUT_MS);
          await this.acknowledge(id);
        } catch (error) {
          this.noteFailure(id, error);
        }
      }),
    );
  }

  private async acknowledge(id: string) {
    if (this.acked.get(id) === this.newest) return;
    this.acked.set(id, this.newest);
    await this.deps.request("state_set", { key: ackKey(id), value: String(this.newest) }, LOCAL_ENV);
  }
}
