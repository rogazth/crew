import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { ruleChanges, ruleRows, rulesUsed, type RuleRow } from "../lib/botRules";
import type { BotRule } from "../lib/protocol";

/** The cap until the daemon says (`crew_core::rules::CAP`). */
const CAP = 1500;

/**
 * A bot's rules as the bot sheet edits them: read when it opens, written on
 * save only if the user changed them, and then by id, so a rule the bot wrote
 * meanwhile survives the save. `bot` null is a bot being made, which has none
 * yet.
 */
export function useBotRules(bot: { id: string } | null) {
  const botId = bot?.id ?? null;
  const [rules, setRules] = useState<{ saved: BotRule[]; rows: RuleRow[]; cap: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    api
      .getBotRules(botId)
      .then((read) => !cancelled && setRules({ saved: read.rules, rows: ruleRows(read.rules), cap: read.cap }))
      .catch(() => !cancelled && setError("Its rules could not be read."));
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const over = rules !== null && rulesUsed(rules.rows) > rules.cap;

  const change = useCallback((rows: RuleRow[]) => {
    setRules((prev) => (prev ? { ...prev, rows } : prev));
    setError(null);
  }, []);

  /** Writes the edit, if any. Throws when it is over the cap or the daemon refused it; `error` says why. */
  const save = useCallback(async () => {
    const changes = botId && rules ? ruleChanges(rules.saved, rules.rows) : null;
    if (!botId || !changes) return;
    if (over) throw new Error("Its rules are over the cap.");
    try {
      const written = await api.saveBotRules(botId, changes);
      // The sheet shows what is stored now, the bot's rules included, and
      // that is what a save retried after the sheet failed further on edits.
      setRules((prev) => (prev ? { ...prev, saved: written.rules, rows: ruleRows(written.rules) } : prev));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    }
  }, [botId, rules, over]);

  return { shown: botId !== null, rows: rules?.rows ?? null, cap: rules?.cap ?? CAP, error, over, change, save };
}
