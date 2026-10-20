import { canonicalOf, formatChord, parseChord, sameKeyOf } from "./chords";
import { COMMAND_IDS, COMMANDS, defaultKeysFor, isCommandId, type CommandId, type KeyOverrides } from "./commands";

/**
 * Keybinding overrides, merged over the defaults: what a command runs on, which
 * commands clash, and what an imported file may say. Pure: the page, the store
 * and the tests share it.
 */

/** The numbered runs (⌘1–9, ⌃⌘1–9) follow one pattern and cannot be rebound one by one. */
export function isEditable(id: string): id is CommandId {
  return isCommandId(id) && !/^(workspace|worktree)-[1-9]$/.test(id);
}

const label = (id: string) => (isCommandId(id) ? COMMANDS[id].label : id);

/** The chords that run the command, each in the form that compares equal when they are the same key. */
function effectiveKeys(id: CommandId, overrides: KeyOverrides, isMac: boolean): string[] {
  const override = overrides[id];
  const specs = override === undefined ? defaultKeysFor(id) : override === null ? [] : [override];
  return specs.flatMap((spec) => sameKeyOf(spec as Parameters<typeof sameKeyOf>[0], isMac) ?? []);
}

/** The command that already runs on `chord`, other than `id`. */
export function findClash(overrides: KeyOverrides, id: string, chord: string, isMac: boolean): CommandId | undefined {
  const key = sameKeyOf(chord, isMac);
  if (!key) return undefined;
  return COMMAND_IDS.find((other) => other !== id && effectiveKeys(other, overrides, isMac).includes(key));
}

function isDefault(id: CommandId, chord: string | null): boolean {
  const defaults = defaultKeysFor(id);
  if (chord === null) return defaults.length === 0;
  const canonical = canonicalOf(chord);
  return defaults.length === 1 && canonicalOf(defaults[0] as Parameters<typeof canonicalOf>[0]) === canonical;
}

/** `chord` for the command (null: none), or the default again once it is the default: an override only exists while it differs. */
export function setOverride(overrides: KeyOverrides, id: CommandId, chord: string | null): KeyOverrides {
  const next = { ...overrides };
  const stored = chord === null ? null : (parseChord(chord) ? formatChord(parseChord(chord)!) : null);
  if (chord !== null && stored === null) return overrides;
  if (isDefault(id, stored)) delete next[id];
  else next[id] = stored;
  return next;
}

export function resetOverride(overrides: KeyOverrides, id: string): KeyOverrides {
  const next = { ...overrides };
  delete next[id];
  return next;
}

/** Gives `chord` to `id` and takes it from `other`, which keeps whatever else it ran on. A fixed command is never unbound. */
export function replaceClash(overrides: KeyOverrides, id: CommandId, chord: string, other: CommandId, isMac: boolean): KeyOverrides {
  if (!isEditable(other)) return overrides;
  const key = sameKeyOf(chord, isMac);
  const left = effectiveKeys(other, overrides, isMac).filter((k) => k !== key);
  const kept = left[0] ?? null;
  return setOverride(setOverride(overrides, other, kept), id, chord);
}

export type ImportResult =
  | { ok: true; overrides: KeyOverrides }
  | { ok: false; errors: string[] };

/**
 * Reads a keybindings file: `{ "version": 1, "overrides": { id: chord | null } }`
 * or the bare map. All or nothing, so a file never half-applies: every unknown
 * command, fixed row, malformed chord and clash is named.
 */
export function parseImport(text: string, isMac: boolean): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["The file is not valid JSON."] };
  }
  const map = isRecord(raw) && "overrides" in raw ? raw.overrides : raw;
  if (!isRecord(map)) return { ok: false, errors: ["Expected an object of command ids and shortcuts."] };

  const errors: string[] = [];
  let overrides: KeyOverrides = {};
  for (const [id, value] of Object.entries(map)) {
    if (!isCommandId(id)) {
      errors.push(`Unknown command “${id}”.`);
    } else if (!isEditable(id)) {
      errors.push(`${label(id)} follows a fixed pattern and cannot be changed.`);
    } else if (value !== null && !parseChord(value)) {
      errors.push(`${label(id)}: “${String(value)}” is not a valid shortcut.`);
    } else {
      overrides = setOverride(overrides, id, value as string | null);
    }
  }
  if (errors.length === 0) errors.push(...clashes(overrides, isMac));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, overrides };
}

/** Every pair of commands left on one chord, as a sentence. */
export function clashes(overrides: KeyOverrides, isMac: boolean): string[] {
  const owners = new Map<string, CommandId[]>();
  for (const id of COMMAND_IDS) {
    for (const key of new Set(effectiveKeys(id, overrides, isMac))) owners.set(key, [...(owners.get(key) ?? []), id]);
  }
  return [...owners.values()].filter((ids) => ids.length > 1).map((ids) => `${ids.map(label).join(" and ")} share a shortcut.`);
}

/** What a stored value says, dropping what no longer parses; for reading back what was saved. */
export function readStored(text: string | null, isMac: boolean): KeyOverrides {
  if (!text) return {};
  const result = parseImport(text, isMac);
  if (result.ok) return result.overrides;
  // A saved set that now clashes (a new default took its chord) still applies entry by entry.
  try {
    const map: unknown = JSON.parse(text);
    if (!isRecord(map)) return {};
    let overrides: KeyOverrides = {};
    for (const [id, value] of Object.entries(map)) {
      if (isEditable(id) && (value === null || parseChord(value))) overrides = setOverride(overrides, id, value as string | null);
    }
    return overrides;
  } catch {
    return {};
  }
}

export function exportOverrides(overrides: KeyOverrides): string {
  return `${JSON.stringify({ version: 1, overrides }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
