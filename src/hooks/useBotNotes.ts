import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { noteEntries, noteTexts, notesUsed, sameNotes, type NoteEntry } from "../lib/botNotes";

/** The cap until the daemon says (`crew_core::notes::CAP`). */
const CAP = 4000;

/**
 * A bot's notes as the bot sheet edits them: read when it opens, written on
 * save only if the user changed them, and then as an edit of what it opened
 * with, so an entry the bot wrote meanwhile survives the save. `bot` null is a bot being made,
 * which has none yet.
 */
export function useBotNotes(bot: { id: string } | null) {
  const botId = bot?.id ?? null;
  const [notes, setNotes] = useState<{ saved: string[]; entries: NoteEntry[]; cap: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    api
      .getBotNotes(botId)
      .then((read) => !cancelled && setNotes({ saved: read.entries, entries: noteEntries(read.entries), cap: read.cap }))
      .catch(() => !cancelled && setError("Its notes could not be read."));
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const texts = notes ? noteTexts(notes.entries) : null;
  const over = notes !== null && texts !== null && notesUsed(texts) > notes.cap;

  const change = useCallback((entries: NoteEntry[]) => {
    setNotes((prev) => (prev ? { ...prev, entries } : prev));
    setError(null);
  }, []);

  /** Writes the edit, if any. Throws when it is over the cap or the daemon refused it; `error` says why. */
  const save = useCallback(async () => {
    if (!botId || !notes || !texts || sameNotes(texts, notes.saved)) return;
    if (over) throw new Error("Its notes are over the cap.");
    try {
      const written = await api.setBotNotes(botId, texts, notes.saved);
      // The sheet shows what is stored now, the bot's entries included, and
      // that is the base of a save retried after the sheet failed further on.
      setNotes((prev) => (prev ? { ...prev, saved: written.entries, entries: noteEntries(written.entries) } : prev));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    }
  }, [botId, notes, over, texts]);

  return { shown: botId !== null, entries: notes?.entries ?? null, cap: notes?.cap ?? CAP, error, over, change, save };
}
