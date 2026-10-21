import { describe, expect, it } from "vitest";
import type { BotRule } from "./protocol";
import { newRuleRow, ruleChanges, ruleRows, rulesUsed } from "./botRules";

const saved: BotRule[] = [
  { id: 1, body: "Never push to master", cited: { excerpt: "nunca hagas push a master", at: 0 } },
  { id: 4, body: "Run the tests before pushing" },
];

describe("bot rules", () => {
  it("sends nothing when nothing changed", () => {
    expect(ruleChanges(saved, ruleRows(saved))).toBeNull();
    // A blank row the user added and left empty is no rule.
    expect(ruleChanges(saved, [...ruleRows(saved), newRuleRow()])).toBeNull();
  });

  it("edits, removes and adds by id", () => {
    const rows = ruleRows(saved);
    rows[0] = { ...rows[0]!, text: "  Never push\n to main " };
    const added = { ...newRuleRow(), text: "Ask before deleting a branch" };
    expect(ruleChanges(saved, [rows[0]!, added])).toEqual({
      add: ["Ask before deleting a branch"],
      edit: [{ id: 1, body: "Never push to main" }],
      remove: [4],
    });
  });

  it("removes a rule the user emptied", () => {
    const rows = ruleRows(saved).map((row) => (row.id === 4 ? { ...row, text: "   " } : row));
    expect(ruleChanges(saved, rows)).toEqual({ add: [], edit: [], remove: [4] });
  });

  it("counts characters the way the daemon caps them", () => {
    expect(rulesUsed([])).toBe(0);
    expect(rulesUsed(ruleRows(saved))).toBe(20 + 28);
    // One emoji is one character, not two UTF-16 units; whitespace collapses.
    expect(rulesUsed([{ ...newRuleRow(), text: " 🪑  a " }])).toBe(3);
  });
});
