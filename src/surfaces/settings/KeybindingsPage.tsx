// Keybindings you can change: click a shortcut and press
// a new one in its place (one per command, never a second), see a clash before
// it happens, reset one or all. The edits live in
// memory; the real keymap (lib/commands) is untouched.
import { DownloadIcon, PlusIcon, RotateCcwIcon, SearchIcon, TriangleAlertIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, Tooltip } from "../../chrome/kit";
import { bindingGroups } from "../../lib/commandGroups";
import { PAGES } from "./pages";
import { Group, SettingsPage, toast } from "./ui";

/* ── State: overrides over the shipped chords ───────────────────────── */

type Overrides = Record<string, string[]>;

// commandChords() drops the key of a `Mod++` chord and leaves "⌘" alone; the lost key is the plus.
const DEFAULTS = bindingGroups().map((g) => ({
  ...g,
  rows: g.rows.map((r) => ({ ...r, chords: r.chords.map((c) => ([...c].every((x) => "⌃⌥⇧⌘".includes(x)) ? `${c}+` : c)) })),
}));
const DEFAULT_CHORDS: Record<string, string[]> = Object.fromEntries(
  DEFAULTS.flatMap((g) => g.rows.map((r) => [r.id, r.chords])),
);
const LABELS: Record<string, string> = Object.fromEntries(DEFAULTS.flatMap((g) => g.rows.map((r) => [r.id, r.label])));

let overrides: Overrides = {};
const listeners = new Set<() => void>();
const setOverrides = (next: Overrides) => {
  overrides = next;
  listeners.forEach((l) => l());
};
const useOverrides = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => overrides,
  );

const chordsOf = (o: Overrides, id: string) => o[id] ?? DEFAULT_CHORDS[id] ?? [];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function assign(o: Overrides, id: string, chords: string[]): Overrides {
  const next = { ...o };
  if (same(chords, DEFAULT_CHORDS[id] ?? [])) delete next[id];
  else next[id] = chords;
  return next;
}

/** Numbered runs (⌘1–9) follow one pattern; they are shown, not edited. */
const fixed = (id: string) => id.endsWith("-n");

/* ── Reading a key press as a chord ─────────────────────────────────── */

const MODS = ["⌃", "⌥", "⇧", "⌘"] as const;

const CODES: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Enter: "↩",
  Tab: "⇥",
  Space: "Space",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function heldMods(e: KeyboardEvent): string {
  return [e.ctrlKey && "⌃", e.altKey && "⌥", e.shiftKey && "⇧", e.metaKey && "⌘"].filter(Boolean).join("");
}

function keyOf(e: KeyboardEvent): string | null {
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter) return letter[1]!;
  const digit = /^Digit(\d)$/.exec(e.code);
  if (digit) return digit[1]!;
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  return CODES[e.code] ?? null;
}

/* ── Page ───────────────────────────────────────────────────────────── */

type Recording = { id: string };
type Clash = { id: string; chord: string; other: string };

export function KeybindingsPage() {
  const o = useOverrides();
  const [query, setQuery] = useState("");
  const [onlyModified, setOnlyModified] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [held, setHeld] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [clash, setClash] = useState<Clash | null>(null);

  const modified = Object.keys(o).length;
  const text = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      DEFAULTS.map((g) => ({
        ...g,
        rows: g.rows.filter(
          (r) =>
            (!onlyModified || r.id in o) &&
            (!text || r.label.toLowerCase().includes(text) || chordsOf(o, r.id).some((c) => c.toLowerCase().includes(text))),
        ),
      })).filter((g) => g.rows.length > 0),
    [o, text, onlyModified],
  );

  // The new chord takes the place of whatever the command had: one shortcut each, never a second.
  const commit = (id: string, chord: string, other?: string) => {
    let next = o;
    if (other) next = assign(next, other, chordsOf(next, other).filter((c) => c !== chord));
    next = assign(next, id, [chord]);
    setOverrides(next);
    setClash(null);
  };

  useEffect(() => {
    if (!recording) return;
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !heldMods(e)) {
        setRecording(null);
        setHeld("");
        setHint(null);
        return;
      }
      const mods = heldMods(e);
      const key = keyOf(e);
      if (!key) {
        setHeld(mods);
        return;
      }
      if (!/[⌃⌥⌘]/.test(mods) && !key.startsWith("F")) {
        setHint("Include ⌘, ⌥ or ⌃");
        setHeld("");
        return;
      }
      const chord = mods + key;
      const other = Object.keys(DEFAULT_CHORDS).find((id) => id !== recording.id && chordsOf(o, id).includes(chord));
      setRecording(null);
      setHeld("");
      setHint(null);
      if (other) setClash({ id: recording.id, chord, other });
      else commit(recording.id, chord);
    };
    const up = (e: KeyboardEvent) => setHeld(heldMods(e));
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  });

  const record = (id: string) => {
    setClash(null);
    setHint(null);
    setHeld("");
    setRecording({ id });
  };

  const reset = (id: string) => {
    const next = { ...o };
    delete next[id];
    setOverrides(next);
    if (clash?.id === id) setClash(null);
  };

  return (
    <SettingsPage
      title="Keybindings"
      description={PAGES.keybindings.description}
      actions={
        <>
          <Button variant="ghost" icon={UploadIcon} onClick={() => toast("Keybindings imported", "info")}>
            Import
          </Button>
          <Button variant="ghost" icon={DownloadIcon} onClick={() => toast("Keybindings exported", "info")}>
            Export
          </Button>
          <Button
            icon={RotateCcwIcon}
            disabled={modified === 0}
            onClick={() => {
              setOverrides({});
              toast(`Reset ${modified} shortcut${modified === 1 ? "" : "s"}`);
            }}
          >
            Reset all
          </Button>
        </>
      }
    >
      <div className="sticky top-0 z-10 -mx-3 -my-3 flex items-center gap-2 bg-canvas px-3 py-3">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-card px-3 transition-shadow focus-within:shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--color-focus)_45%,transparent)]">
          <SearchIcon className="size-4 shrink-0 text-icon" />
          <input
            value={query}
            spellCheck={false}
            placeholder="Search commands or keys"
            aria-label="Search keybindings"
            onChange={(e) => setQuery(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
          />
        </label>
        <button
          type="button"
          aria-pressed={onlyModified}
          onClick={() => setOnlyModified((v) => !v)}
          className={`flex h-9 shrink-0 items-center gap-2 rounded-full px-3 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 ${
            onlyModified ? "bg-accent/12 text-accent" : "bg-card text-text-muted hover:bg-hover hover:text-text"
          }`}
        >
          <span className={`size-1.5 rounded-full ${modified ? "bg-accent" : "bg-text-muted/50"}`} />
          Modified
          <span className="tabular-nums opacity-70">{modified}</span>
        </button>
      </div>

      {groups.map((group) => (
        <Group key={group.title} title={group.title}>
          {group.rows.map((row) => {
            const chords = chordsOf(o, row.id);
            const changed = row.id in o;
            const rec = recording?.id === row.id ? recording : null;
            const rowClash = clash?.id === row.id ? clash : null;
            return (
              <div key={row.id} data-setting={`kb:${row.id}`} className="py-1.5">
                <div className="group/row flex min-h-8 items-center gap-3">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{row.label}</span>
                    {changed && (
                      <Tooltip
                        content={`Changed from ${DEFAULT_CHORDS[row.id]?.join(" or ") || "no shortcut"}`}
                        render={<span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Modified" />}
                      />
                    )}
                  </span>
                  {changed && !rec && (
                    <button
                      type="button"
                      onClick={() => reset(row.id)}
                      className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-text-muted hover:bg-hover hover:text-text"
                    >
                      <RotateCcwIcon className="size-3" />
                      Reset
                    </button>
                  )}
                  <span className="-mr-1 flex items-center gap-1">
                    {rec ? (
                      <Recorder held={held} hint={hint} />
                    ) : chords.length > 0 ? (
                      // A command the app ships with two chords shows both; pressing a new one replaces the pair.
                      <ChordButton
                        chords={chords}
                        locked={fixed(row.id)}
                        onRecord={() => record(row.id)}
                        onRemove={() => setOverrides(assign(o, row.id, []))}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => record(row.id)}
                        className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
                      >
                        <PlusIcon className="size-3.5" /> Set
                      </button>
                    )}
                  </span>
                </div>
                {rowClash && (
                  <div className="mt-1.5 mb-1 flex items-center gap-3 rounded-lg bg-warning/12 py-1.5 pr-1.5 pl-3">
                    <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
                    <p className="min-w-0 flex-1 text-[12px]">
                      <Chord chord={rowClash.chord} small /> is used by{" "}
                      <span className="font-medium">{LABELS[rowClash.other]}</span>
                    </p>
                    <Button variant="ghost" className="h-7 text-[12px]" onClick={() => setClash(null)}>
                      Cancel
                    </Button>
                    <Button
                      className="h-7 text-[12px]"
                      onClick={() => commit(rowClash.id, rowClash.chord, rowClash.other)}
                    >
                      Replace
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </Group>
      ))}
      {groups.length === 0 && (
        <div className="flex flex-col items-center gap-1 py-10 text-center">
          <p>{onlyModified && !text ? "No changes yet" : `No results for “${query.trim()}”`}</p>
          <p className="text-[12px] text-text-muted">
            {onlyModified ? "Edited shortcuts appear here." : "Try a command name or key."}
          </p>
        </div>
      )}
    </SettingsPage>
  );
}

function ChordButton({
  chords,
  locked,
  onRecord,
  onRemove,
}: {
  chords: string[];
  locked: boolean;
  onRecord: () => void;
  onRemove: () => void;
}) {
  const caps = chords.map((chord, index) => (
    <span key={chord} className="flex items-center gap-1">
      {index > 0 && <span className="px-0.5 text-[11px] text-placeholder">or</span>}
      <Chord chord={chord} />
    </span>
  ));
  if (locked)
    return (
      <Tooltip content="Fixed pattern" render={<span className="flex h-7 items-center gap-1 px-1" />}>
        {caps}
      </Tooltip>
    );
  return (
    <span className="group/chord relative">
      <Tooltip
        content="Click to change"
        render={
          <button
            type="button"
            onClick={onRecord}
            aria-label={`Change ${chords.join(" or ")}`}
            className="flex h-7 items-center gap-1 rounded-md px-1 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
          />
        }
      >
        {caps}
      </Tooltip>
      <button
        type="button"
        aria-label="Remove shortcut"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-surface text-icon opacity-0 shadow-[0_0_0_1px_var(--color-hairline),0_1px_2px_oklch(0%_0_0/0.1)] transition-opacity group-hover/chord:opacity-100 hover:text-danger focus-visible:opacity-100"
      >
        <XIcon className="size-2.5" strokeWidth={3} />
      </button>
    </span>
  );
}

function Recorder({ held, hint }: { held: string; hint: string | null }) {
  return (
    <span
      role="status"
      className="flex h-7 items-center gap-2 rounded-md bg-accent/10 px-2.5 text-[12px] shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-accent)_55%,transparent)]"
    >
      {held ? (
        <Chord chord={held} />
      ) : (
        <span className={`${hint ? "text-warning" : "text-accent"} font-medium`}>{hint ?? "Press keys…"}</span>
      )}
      <span className="text-text-muted">esc</span>
    </span>
  );
}

/** One keycap per modifier, then the key, the way the keys are pressed. */
function Chord({ chord, small = false }: { chord: string; small?: boolean }) {
  const glyphs = [...chord];
  const mods = glyphs.filter((g) => (MODS as readonly string[]).includes(g));
  const key = glyphs.filter((g) => !(MODS as readonly string[]).includes(g)).join("");
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {[...mods, key].filter(Boolean).map((cap, i) => (
        <kbd
          key={i}
          className={`inline-flex items-center justify-center bg-canvas font-sans font-medium text-text shadow-[0_0_0_1px_var(--color-hairline),0_1px_1px_oklch(0%_0_0/0.06)] ${
            small ? "h-[18px] min-w-[18px] rounded-[5px] px-1 text-[11px]" : "h-6 min-w-6 rounded-md px-1.5 text-[12px]"
          }`}
        >
          {cap}
        </kbd>
      ))}
    </span>
  );
}
