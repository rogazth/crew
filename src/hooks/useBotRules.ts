import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { ruleChanges, ruleRows, rulesUsed, type RuleRow } from "../lib/botRules";
import type { BotRule } from "../lib/protocol";

/** The cap until the daemon says (`crew_core::rules::CAP`). */
const CAP = 1500;

/**
 * A bot's rules as its pane shows them: read when it opens, and each change
 * written as it is made, by id, so a rule the bot wrote meanwhile survives.
 * `bot` null is a bot being made, which has none yet.
 */
export function useBotRules(bot: { id: string } | null) {
  const botId = bot?.id ?? null;
  const [rules, setRules] = useState<{ saved: BotRule[]; rows: RuleRow[]; cap: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What is stored, for the next write to diff against while the last is in flight.
  const saved = useRef<BotRule[]>([]);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    api
      .getBotRules(botId)
      .then((read) => {
        if (cancelled) return;
        saved.current = read.rules;
        setRules({ saved: read.rules, rows: ruleRows(read.rules), cap: read.cap });
      })
      .catch(() => !cancelled && setError("Its rules could not be read."));
    return () => {
      cancelled = true;
    };
  }, [botId]);

  /** Shows `rows` at once and writes what changed; refused, the rows stay as typed and `error` says why. */
  const commit = useCallback(
    async (rows: RuleRow[]) => {
      setRules((prev) => (prev ? { ...prev, rows } : prev));
      setError(null);
      const changes = botId ? ruleChanges(saved.current, rows) : null;
      if (!botId || !changes) return;
      if (rulesUsed(rows) > (rules?.cap ?? CAP)) return setError(`Over the ${(rules?.cap ?? CAP).toLocaleString("en-US")} characters rules hold.`);
      try {
        const written = await api.saveBotRules(botId, changes);
        saved.current = written.rules;
        // A row still being typed into keeps its text; the rest are what is stored now, the bot's included.
        setRules((prev) => (prev ? { ...prev, saved: written.rules, rows: merge(written.rules, prev.rows) } : prev));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [botId, rules?.cap],
  );

  /** The most its rules may hold, never under the default; shown at once, kept as the daemon kept it. */
  const setCap = useCallback(
    async (cap: number) => {
      if (!botId) return;
      setRules((prev) => (prev ? { ...prev, cap: Math.max(cap, CAP) } : prev));
      const written = await api.setBotRulesCap(botId, cap).catch(() => null);
      if (written) setRules((prev) => (prev ? { ...prev, cap: written.cap } : prev));
    },
    [botId],
  );

  return { rows: rules?.rows ?? null, cap: rules?.cap ?? CAP, error, commit, setCap };
}

/** The stored rules in the rows' order, keeping each row's key so nothing remounts under the caret; an empty new row stays. */
function merge(stored: BotRule[], rows: RuleRow[]): RuleRow[] {
  const fresh = ruleRows(stored);
  const keyOf = new Map(rows.flatMap((row) => (row.id ? [[row.id, row.key] as const] : [])));
  const unsaved = rows.filter((row) => row.id === null && !row.text.trim());
  // A row added a moment ago is stored now: it takes the id the daemon gave it, at the end.
  return [...fresh.map((row) => ({ ...row, key: keyOf.get(row.id!) ?? row.key })), ...unsaved];
}
