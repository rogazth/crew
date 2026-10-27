import type { BotRule, BotRulesSave } from "./protocol";

/**
 * One rule being edited in the bot sheet: `id` is the stored rule's (`r3`),
 * null for one being added; `key` keeps its row while the text changes.
 */
export type RuleRow = { key: number; id: string | null; text: string };

let nextKey = 0;

export function ruleRows(rules: BotRule[]): RuleRow[] {
  return rules.map((rule) => ({ key: nextKey++, id: rule.id, text: rule.body }));
}

export function newRuleRow(): RuleRow {
  return { key: nextKey++, id: null, text: "" };
}

/** A rule as the daemon stores it: one line, its whitespace collapsed (`crew_core::rules::tidy`). */
export function tidyRule(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Characters the rules take, as the daemon caps them: code points of each body, nothing between. */
export function rulesUsed(rows: RuleRow[]): number {
  return rows.reduce((sum, row) => sum + [...tidyRule(row.text)].length, 0);
}

/**
 * What the sheet sends: the rules it removed (or emptied), the ones whose text
 * changed, and the new ones, by id. Null when nothing changed.
 */
export function ruleChanges(saved: BotRule[], rows: RuleRow[]): Omit<BotRulesSave, "id"> | null {
  const remove: string[] = [];
  const edit: BotRulesSave["edit"] = [];
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
