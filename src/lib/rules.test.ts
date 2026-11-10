import { describe, expect, it } from "vitest";
import type { Rule } from "./protocol";
import { newRuleRow, ruleChanges, ruleRows } from "./rules";

const saved: Rule[] = [
  { id: "r1", body: "Never push to master" },
  { id: "r4", body: "Run the tests before pushing" },
];

describe("rules", () => {
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
      edit: [{ id: "r1", body: "Never push to main" }],
      remove: ["r4"],
    });
  });

  it("removes a rule the user emptied", () => {
    const rows = ruleRows(saved).map((row) => (row.id === "r4" ? { ...row, text: "   " } : row));
    expect(ruleChanges(saved, rows)).toEqual({ add: [], edit: [], remove: ["r4"] });
  });
});
