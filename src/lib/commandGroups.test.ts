import { describe, expect, it } from "vitest";
import { bindingGroups, groupedCommandIds } from "./commandGroups";
import { COMMAND_IDS } from "./commands";

describe("bindingGroups", () => {
  it("lists every command exactly once", () => {
    const listed = groupedCommandIds();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...COMMAND_IDS].sort());
  });

  it("folds a numbered run into one row", () => {
    const rows = bindingGroups().flatMap((group) => group.rows);
    expect(rows.filter((row) => row.id.startsWith("workspace-"))).toHaveLength(1);
    expect(rows.find((row) => row.id === "workspace-n")?.chords[0]).toMatch(/1–9$/);
  });

  it("shows a command's other chords too", () => {
    const rows = bindingGroups().flatMap((group) => group.rows);
    expect(rows.find((row) => row.id === "zoom-in")?.chords.length).toBeGreaterThan(1);
  });
});
