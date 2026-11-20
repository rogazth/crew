import { afterEach, describe, expect, it } from "vitest";
import { bindingGroups, groupedCommandIds, sheetColumns } from "./commandGroups";
import { COMMAND_IDS, setKeyOverrides } from "./commands";

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

describe("sheetColumns", () => {
  afterEach(() => setKeyOverrides({}));

  const rows = () => sheetColumns().flatMap((column) => column.flatMap((group) => group.rows));

  it("leaves out what has no chord, and a section left empty", () => {
    expect(rows().every((row) => row.keys.length > 0 && row.keys.every(Boolean))).toBe(true);
    const titles = sheetColumns().flatMap((column) => column.map((group) => group.title));
    expect(titles).not.toContain("Services");
  });

  it("shows a pair as one line while both have a chord, and the one left alone otherwise", () => {
    expect(rows().find((row) => row.label === "Close / reopen tab")?.keys).toHaveLength(2);
    setKeyOverrides({ close: null });
    expect(rows().some((row) => row.label === "Close / reopen tab")).toBe(false);
    expect(rows().find((row) => row.label === "Reopen closed tab")?.keys).toHaveLength(1);
  });

  it("shows a command once someone binds it", () => {
    expect(rows().some((row) => row.label === "Routines")).toBe(false);
    setKeyOverrides({ "open-routines": "Mod+Alt+R" });
    expect(rows().find((row) => row.label === "Routines")?.keys).toHaveLength(1);
  });
});
