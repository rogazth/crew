import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { ruleChanges, ruleRows, type RuleChanges, type RuleRow } from "../lib/rules";
import type { Rule } from "../lib/protocol";

/** Whose rules: a bot's, which it writes too, or a workspace's, which only the user writes. */
export type RulesOwner = { kind: "bot" | "workspace"; id: string };

const read = (owner: RulesOwner): Promise<Rule[]> =>
  owner.kind === "bot" ? api.getBotRules(owner.id).then((r) => r.rules) : api.getWorkspaceProfile(owner.id).then((p) => p.rules);

const write = (owner: RulesOwner, changes: RuleChanges): Promise<Rule[]> =>
  owner.kind === "bot"
    ? api.saveBotRules(owner.id, changes).then((r) => r.rules)
    : api.saveWorkspaceProfile(owner.id, changes).then((p) => p.rules);

/**
 * Rules as their editor shows them: read when it opens, and each change
 * written as it is made, by id, so a rule written meanwhile (by the bot, or in
 * another window) survives. `owner` null is a bot being made, which has none yet.
 */
export function useRules(owner: RulesOwner | null) {
  const kind = owner?.kind ?? null;
  const id = owner?.id ?? null;
  const [rows, setRows] = useState<RuleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What is stored, for the next write to diff against while the last is in flight.
  const saved = useRef<Rule[]>([]);

  useEffect(() => {
    if (!kind || !id) return;
    let cancelled = false;
    read({ kind, id })
      .then((rules) => {
        if (cancelled) return;
        saved.current = rules;
        setRows(ruleRows(rules));
      })
      .catch(() => !cancelled && setError("The rules could not be read."));
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  /** Shows `next` at once and writes what changed; refused, the rows stay as typed and `error` says why. */
  const commit = useCallback(
    async (next: RuleRow[]) => {
      setRows(next);
      setError(null);
      const changes = kind && id ? ruleChanges(saved.current, next) : null;
      if (!kind || !id || !changes) return;
      try {
        const written = await write({ kind, id }, changes);
        saved.current = written;
        // A row still being typed into keeps its text; the rest are what is stored now, the bot's included.
        setRows((prev) => (prev ? merge(written, prev) : prev));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [kind, id],
  );

  return { rows, error, commit };
}

/** The stored rules in the rows' order, keeping each row's key so nothing remounts under the caret; an empty new row stays. */
function merge(stored: Rule[], rows: RuleRow[]): RuleRow[] {
  const fresh = ruleRows(stored);
  const keyOf = new Map(rows.flatMap((row) => (row.id ? [[row.id, row.key] as const] : [])));
  const unsaved = rows.filter((row) => row.id === null && !row.text.trim());
  // A row added a moment ago is stored now: it takes the id the daemon gave it, at the end.
  return [...fresh.map((row) => ({ ...row, key: keyOf.get(row.id!) ?? row.key })), ...unsaved];
}
