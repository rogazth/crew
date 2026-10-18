import { PlusIcon, XIcon } from "lucide-react";
import { Button, IconButton, TextArea } from "./kit";
import type { useBotNotes } from "../hooks/useBotNotes";
import { newNoteEntry, noteTexts, notesUsed } from "../lib/botNotes";

const count = (n: number) => n.toLocaleString("en-US");

/**
 * A bot's notes, a row per entry: what it keeps for later turns, apart from its
 * description. The bot writes them too, with its memory tool. Nothing for a bot
 * being made; `entries` is null while they are read.
 */
export function BotNotes({ notes }: { notes: ReturnType<typeof useBotNotes> }) {
  const { shown, entries, cap, error, change: onChange } = notes;
  if (!shown) return null;
  const used = entries ? notesUsed(noteTexts(entries)) : 0;
  const over = used > cap;
  return (
    <section aria-label="Notes" className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-text-muted">Notes</span>
        {entries && (
          <span className={`text-[11.5px] tabular-nums ${over ? "text-danger" : "text-text-muted"}`}>
            {count(used)}/{count(cap)}
          </span>
        )}
      </div>
      {entries ? (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <div key={entry.key} className="flex items-start gap-1">
              <TextArea
                rows={2}
                aria-label="Note"
                value={entry.text}
                className="min-h-0 flex-1"
                onChange={(event) =>
                  onChange(entries.map((row) => (row.key === entry.key ? { ...row, text: event.target.value } : row)))
                }
              />
              <IconButton
                icon={XIcon}
                label="Remove note"
                onClick={() => onChange(entries.filter((row) => row.key !== entry.key))}
              />
            </div>
          ))}
          <Button variant="ghost" icon={PlusIcon} className="self-start" onClick={() => onChange([...entries, newNoteEntry()])}>
            Add note
          </Button>
        </div>
      ) : (
        !error && <span className="text-[12px] text-text-muted">Reading its notes…</span>
      )}
      {error ? (
        <span className="text-[12px] text-danger">{error}</span>
      ) : over ? (
        <span className="text-[12px] text-danger">Over the {count(cap)} characters notes hold: shorten or remove some.</span>
      ) : (
        <span className="text-[12px] text-text-muted">What it keeps for later turns, such as ids and decisions. Read every turn.</span>
      )}
    </section>
  );
}
