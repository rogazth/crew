// Keybindings you can change: click a shortcut and press a new one in its place
// (one per command, never a second), see a clash before it happens, reset one or
// all, import and export the set as JSON. Edits are saved and bind at once, in
// the window and in the keys main forwards from pages.
import { DownloadIcon, PlusIcon, RotateCcwIcon, SearchIcon, TriangleAlertIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Tooltip } from "../../chrome/kit";
import { saveKeyOverrides, useKeyOverrides } from "../../hooks/useKeybindings";
import { chordFromPress } from "../../lib/chords";
import { COMMANDS, isCommandId, storedChordLabel, type CommandId } from "../../lib/commands";
import { bindingGroups } from "../../lib/commandGroups";
import { IS_MAC } from "../../lib/hotkey";
import { keybindingsHost } from "../../lib/host";
import { exportOverrides, findClash, parseImport, replaceClash, resetOverride, setOverride } from "../../lib/keybindings";
import { PAGES } from "./pages";
import { Group, SettingsPage, toast } from "./ui";

const MODS = ["⌃", "⌥", "⇧", "⌘"] as const;

const labelOf = (id: string) => (isCommandId(id) ? COMMANDS[id].label : id);

function heldMods(e: KeyboardEvent): string {
  return [e.ctrlKey && "⌃", e.altKey && "⌥", e.shiftKey && "⇧", e.metaKey && "⌘"].filter(Boolean).join("");
}

/* ── Page ───────────────────────────────────────────────────────────── */

type Clash = { id: CommandId; chord: string; other: CommandId };

export function KeybindingsPage() {
  const o = useKeyOverrides();
  const [query, setQuery] = useState("");
  const [onlyModified, setOnlyModified] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  const [held, setHeld] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [clash, setClash] = useState<Clash | null>(null);
  const [importErrors, setImportErrors] = useState<string[] | null>(null);

  const modified = Object.keys(o).length;
  const text = query.trim().toLowerCase();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the rows read the live bindings, which `o` stands for
  const all = useMemo(() => bindingGroups(), [o]);
  const groups = useMemo(
    () =>
      all
        .map((g) => ({
          ...g,
          rows: g.rows.filter(
            (r) =>
              (!onlyModified || r.id in o) &&
              (!text || r.label.toLowerCase().includes(text) || r.chords.some((c) => c.toLowerCase().includes(text))),
          ),
        }))
        .filter((g) => g.rows.length > 0),
    [all, o, text, onlyModified],
  );

  // The new chord takes the place of whatever the command had: one shortcut each, never a second.
  const commit = (id: CommandId, chord: string, other?: CommandId) => {
    saveKeyOverrides(other ? replaceClash(o, id, chord, other, IS_MAC) : setOverride(o, id, chord));
    setClash(null);
  };

  useEffect(() => {
    if (!recording) return;
    const stop = () => {
      setRecording(null);
      setHeld("");
      setHint(null);
    };
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !heldMods(e)) return stop();
      const mods = heldMods(e);
      const chord = chordFromPress(e, IS_MAC);
      if (!chord) {
        setHeld(mods);
        return;
      }
      if (!/^(Mod|Ctrl|Alt|Meta)\+|^F\d/.test(chord)) {
        setHint("Include ⌘, ⌥ or ⌃");
        setHeld("");
        return;
      }
      const id = recording as CommandId;
      const other = findClash(o, id, chord, IS_MAC);
      stop();
      if (other) setClash({ id, chord, other });
      else commit(id, chord);
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
    setRecording(id);
  };

  const reset = (id: string) => {
    saveKeyOverrides(resetOverride(o, id));
    if (clash?.id === id) setClash(null);
  };

  const importFile = async () => {
    const host = keybindingsHost();
    if (!host) return setImportErrors(["Importing needs the desktop app."]);
    try {
      const file = await host.importFile();
      if (file === null) return;
      const result = parseImport(file, IS_MAC);
      if (!result.ok) return setImportErrors(result.errors);
      saveKeyOverrides(result.overrides);
      setImportErrors(null);
      setClash(null);
      toast(`Imported ${Object.keys(result.overrides).length} changed shortcut${Object.keys(result.overrides).length === 1 ? "" : "s"}`);
    } catch (error) {
      setImportErrors([error instanceof Error ? error.message : "Could not read the file."]);
    }
  };

  const exportFile = async () => {
    const host = keybindingsHost();
    if (!host) return toast("Exporting needs the desktop app", "danger");
    try {
      if ((await host.exportFile(exportOverrides(o))) !== null) toast("Keybindings exported");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the file", "danger");
    }
  };

  return (
    <SettingsPage
      title="Keybindings"
      description={PAGES.keybindings.description}
      actions={
        <>
          <Button variant="ghost" icon={UploadIcon} onClick={() => void importFile()}>
            Import
          </Button>
          <Button variant="ghost" icon={DownloadIcon} onClick={() => void exportFile()}>
            Export
          </Button>
          <Button
            icon={RotateCcwIcon}
            disabled={modified === 0}
            onClick={() => {
              saveKeyOverrides({});
              setClash(null);
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

      {importErrors && (
        <div role="alert" className="flex items-start gap-3 rounded-lg bg-danger/10 py-2 pr-1.5 pl-3">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1 text-[12px]">
            <p className="font-medium">Nothing was imported</p>
            <ul className="mt-0.5 text-text-muted">
              {importErrors.slice(0, 6).map((error) => (
                <li key={error}>{error}</li>
              ))}
              {importErrors.length > 6 && <li>and {importErrors.length - 6} more</li>}
            </ul>
          </div>
          <Button variant="ghost" className="h-7 text-[12px]" onClick={() => setImportErrors(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {groups.map((group) => (
        <Group key={group.title} title={group.title}>
          {group.rows.map((row) => {
            const chords = row.chords;
            const changed = row.id in o;
            const rec = recording === row.id;
            const rowClash = clash?.id === row.id ? clash : null;
            return (
              <div key={row.id} data-setting={`kb:${row.id}`} className="py-1.5">
                <div className="group/row flex min-h-8 items-center gap-3">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{row.label}</span>
                    {changed && (
                      <Tooltip
                        content={`Changed from ${row.defaults.join(" or ") || "no shortcut"}`}
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
                        locked={row.fixed}
                        onRecord={() => record(row.id)}
                        onRemove={() => saveKeyOverrides(setOverride(o, row.id as CommandId, null))}
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
                      <Chord chord={storedChordLabel(rowClash.chord)} small /> is used by{" "}
                      <span className="font-medium">{labelOf(rowClash.other)}</span>
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
  // Off macOS a chord is spelled Ctrl+Shift+K, a "+" key last: Ctrl++.
  const caps = mods.length === 0 && chord.length > 1 && chord.includes("+") ? chord.split(/\+(?=.)/) : [...mods, key];
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {caps.filter(Boolean).map((cap, i) => (
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
