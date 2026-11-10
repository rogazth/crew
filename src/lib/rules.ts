import type { Rule, RuleEdit } from "./protocol";

/**
 * One rule being edited, a bot's or a workspace's: `id` is the stored rule's
 * (`r3`, `w3`), null for one being added; `key` keeps its row while the text
 * changes.
 */
export type RuleRow = { key: number; id: string | null; text: string };

let nextKey = 0;

export function ruleRows(rules: Rule[]): RuleRow[] {
  return rules.map((rule) => ({ key: nextKey++, id: rule.id, text: rule.body }));
}

export function newRuleRow(): RuleRow {
  return { key: nextKey++, id: null, text: "" };
}

/** A rule as the daemon stores it: one line, its whitespace collapsed (`crew_core::rules::tidy`). */
export function tidyRule(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** The user's edit of the rules, by id, as `bot_rules_save` and `workspace_profile_save` take it. */
export type RuleChanges = { add: string[]; edit: RuleEdit[]; remove: string[] };

/**
 * What is sent: the rules removed (or emptied), the ones whose text changed,
 * and the new ones, by id. Null when nothing changed.
 */
export function ruleChanges(saved: Rule[], rows: RuleRow[]): RuleChanges | null {
  const remove: string[] = [];
  const edit: RuleEdit[] = [];
  const byId = new Map(rows.flatMap((row) => (row.id === null ? [] : [[row.id, row] as const])));
  for (const rule of saved) {
    const row = byId.get(rule.id);
    const body = row ? tidyRule(row.text) : "";
    if (!body) remove.push(rule.id);
    else if (body !== rule.body) edit.push({ id: rule.id, body });
  }
  const add = rows.flatMap((row) => (row.id === null && tidyRule(row.text) ? [tidyRule(row.text)] : []));
  return remove.length || edit.length || add.length ? { add, edit, remove } : null;
}
