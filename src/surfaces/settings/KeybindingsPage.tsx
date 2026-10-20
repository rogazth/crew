// Keybindings, read-only until S6 of docs/plans/2026-10-19-design-system-finish.md
// makes them changeable: every command with its shortcuts, grouped as the app
// is, and a search over names and keys.
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { bindingGroups } from "../../lib/commandGroups";
import { PAGES } from "./pages";
import { Group, SettingsPage } from "./ui";

const MODS = ["⌃", "⌥", "⇧", "⌘"] as const;

// commandChords() drops the key of a `Mod++` chord and leaves "⌘" alone; the lost key is the plus.
const GROUPS = bindingGroups().map((g) => ({
  ...g,
  rows: g.rows.map((r) => ({ ...r, chords: r.chords.map((c) => ([...c].every((x) => "⌃⌥⇧⌘".includes(x)) ? `${c}+` : c)) })),
}));

export function KeybindingsPage() {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        rows: g.rows.filter((r) => !text || r.label.toLowerCase().includes(text) || r.chords.some((c) => c.toLowerCase().includes(text))),
      })).filter((g) => g.rows.length > 0),
    [text],
  );

  return (
    <SettingsPage title="Keybindings" description={PAGES.keybindings.description}>
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
      </div>

      {groups.map((group) => (
        <Group key={group.title} title={group.title}>
          {group.rows.map((row) => (
            <div key={row.id} data-setting={`kb:${row.id}`} className="flex min-h-11 items-center gap-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="flex items-center gap-1">
                {row.chords.length === 0 ? (
                  <span className="text-[12px] text-placeholder">Not bound</span>
                ) : (
                  row.chords.map((chord, index) => (
                    <span key={chord} className="flex items-center gap-1">
                      {index > 0 && <span className="px-0.5 text-[11px] text-placeholder">or</span>}
                      <Chord chord={chord} />
                    </span>
                  ))
                )}
              </span>
            </div>
          ))}
        </Group>
      ))}
      {groups.length === 0 && (
        <div className="flex flex-col items-center gap-1 py-10 text-center">
          <p>No results for “{query.trim()}”</p>
          <p className="text-[12px] text-text-muted">Try a command name or key.</p>
        </div>
      )}
    </SettingsPage>
  );
}

/** One keycap per modifier, then the key, the way the keys are pressed. */
function Chord({ chord }: { chord: string }) {
  const glyphs = [...chord];
  const mods = glyphs.filter((g) => (MODS as readonly string[]).includes(g));
  const key = glyphs.filter((g) => !(MODS as readonly string[]).includes(g)).join("");
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {[...mods, key].filter(Boolean).map((cap, i) => (
        <kbd
          key={i}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-canvas px-1.5 font-sans text-[12px] font-medium text-text shadow-[0_0_0_1px_var(--color-hairline),0_1px_1px_oklch(0%_0_0/0.06)]"
        >
          {cap}
        </kbd>
      ))}
    </span>
  );
}
