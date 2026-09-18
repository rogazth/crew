import { useEffect, useMemo, useState } from "react";
import {
  COMMANDS,
  COMMAND_IDS,
  IS_MAC,
  formatChord,
  fuzzyMatch,
  type Chord,
  type CommandGroup,
  type CommandId,
} from "@crew/fixtures";
import { Button, Card, InputWith, Kbd } from "@/ui";
import { store, useApp } from "@/lib/store";

/** Punctuation is read off the physical key, so a rebind survives a layout change. */
const CODE_KEY: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
};

const MODIFIER = /^(Shift|Control|Alt|Meta|OS|CapsLock|NumLock|Dead)$/;

function keyOf(event: KeyboardEvent): string {
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter?.[1]) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit?.[1]) return digit[1];
  return CODE_KEY[event.code] ?? event.key;
}

function chordOf(event: KeyboardEvent): Chord {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  return {
    key: keyOf(event),
    ...(mod ? { mod: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
    ...(IS_MAC && event.ctrlKey ? { ctrl: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
  };
}

const chordId = (chord: Chord): string =>
  [chord.mod && "mod", chord.ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", chord.key.toLowerCase()]
    .filter(Boolean)
    .join("+");

export function Keybindings() {
  const keys = useApp().keys;
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<CommandId | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      // While recording, the window belongs to this row: nothing else sees a key.
      event.preventDefault();
      event.stopPropagation();
      if (MODIFIER.test(event.key)) return;
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      store.setKey(recording, chordOf(event));
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const owners = useMemo(() => {
    const map = new Map<string, CommandId[]>();
    for (const id of COMMAND_IDS) {
      const chord = keys[id] ?? COMMANDS[id].keys;
      const at = chordId(chord);
      map.set(at, [...(map.get(at) ?? []), id]);
    }
    return map;
  }, [keys]);

  const groups = useMemo(() => {
    const out = new Map<CommandGroup, CommandId[]>();
    for (const id of COMMAND_IDS) {
      if (query.trim() && !fuzzyMatch(query, COMMANDS[id].label)) continue;
      const group = COMMANDS[id].group;
      out.set(group, [...(out.get(group) ?? []), id]);
    }
    return [...out.entries()];
  }, [query]);

  const shown = groups.reduce((total, [, ids]) => total + ids.length, 0);

  const rows: Array<{ kind: "head"; group: CommandGroup } | { kind: "row"; id: CommandId }> = [];
  for (const [group, ids] of groups) {
    rows.push({ kind: "head", group });
    for (const id of ids) rows.push({ kind: "row", id });
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <InputWith
          className="flex-1"
          lead={
            <span className="font-mono text-xs" aria-hidden>
              /
            </span>
          }
          trail={
            <span className="font-mono text-xs text-ink-4">
              {shown}/{COMMAND_IDS.length}
            </span>
          }
        >
          <input
            value={query}
            placeholder="Filter commands"
            aria-label="Filter commands"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-4"
          />
        </InputWith>
        <Button
          onClick={() => {
            setRecording(null);
            store.resetKeys();
            store.notify("Keybindings reset to defaults");
          }}
        >
          Reset to defaults
        </Button>
      </div>

      <Card>
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-ink-3">
            No command matches <span className="font-mono text-ink-2">{query}</span>.
          </div>
        ) : (
          rows.map((entry) => {
            if (entry.kind === "head") {
              return (
                <div
                  key={`head-${entry.group}`}
                  className="border-b border-rule bg-sunken px-3 py-1 font-mono text-xs tracking-wide text-ink-3 uppercase"
                >
                  {entry.group}
                </div>
              );
            }
            const id = entry.id;
            const chord = keys[id] ?? COMMANDS[id].keys;
            const rivals = (owners.get(chordId(chord)) ?? []).filter((other) => other !== id);
            const rival = rivals[0];
            return (
              <button
                key={id}
                type="button"
                onClick={() => setRecording(id)}
                className="flex h-[var(--row-h)] w-full items-center gap-3 border-b border-rule px-3 text-left transition-colors duration-[var(--fast)] last:border-b-0 hover:bg-sunken"
              >
                <span className="truncate text-md text-ink">{COMMANDS[id].label}</span>
                {rival ? (
                  <span className="truncate text-xs text-red-ink">
                    also {COMMANDS[rival].label}
                    {rivals.length > 1 ? ` +${rivals.length - 1}` : ""}
                  </span>
                ) : null}
                <span className="ml-auto shrink-0">
                  {recording === id ? (
                    <span className="inline-flex h-4 items-center rounded-[var(--r)] border border-accent px-1 font-mono text-xs leading-none text-accent-ink">
                      press a chord · Esc to cancel
                    </span>
                  ) : (
                    <Kbd {...(rival ? { className: "border-red text-red-ink" } : {})}>
                      {formatChord(chord)}
                    </Kbd>
                  )}
                </span>
              </button>
            );
          })
        )}
      </Card>

      <p className="text-sm text-ink-4">
        Click a chord to rebind it. A chord may be held by two commands — the conflict is flagged,
        not blocked, and the first command in this list wins at runtime.
      </p>
    </>
  );
}
