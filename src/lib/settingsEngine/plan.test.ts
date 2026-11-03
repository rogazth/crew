import { describe, expect, test } from "vitest";
import type { SettingRow } from "../protocol";
import { isNewer, missingFrom, newestRevision, toSeed, winners } from "./plan";

const row = (key: string, value: string | null, revision: number, origin = "a", scope = "global"): SettingRow => ({
  key,
  value,
  revision,
  origin,
  scope,
});

describe("winners", () => {
  test("takes the newest revision of each key across the copies", () => {
    const best = winners([[row("k", "old", 1)], [row("k", "new", 2)], [row("other", "x", 1)]]);
    expect(best.get("k")?.value).toBe("new");
    expect(best.get("other")?.value).toBe("x");
  });

  test("breaks a tie by origin, so every order picks the same row", () => {
    const a = row("k", "a", 5, "a");
    const b = row("k", "b", 5, "b");
    expect(winners([[a], [b]]).get("k")).toEqual(b);
    expect(winners([[b], [a]]).get("k")).toEqual(b);
    expect(isNewer(b, a)).toBe(true);
  });

  test("a default chosen later beats a value chosen earlier", () => {
    expect(winners([[row("k", "90", 1)], [row("k", null, 2)]]).get("k")?.value).toBeNull();
  });

  test("leaves out a machine's own settings", () => {
    expect(winners([[row("k", "v", 9, "a", "env")]]).size).toBe(0);
  });
});

describe("missingFrom", () => {
  test("names what a copy lacks or holds older, and nothing it already holds", () => {
    const best = winners([[row("a", "1", 3), row("b", "2", 3), row("c", "3", 3)]]);
    const missing = missingFrom([row("a", "1", 3), row("b", "old", 1)], best);
    expect(missing.map((held) => held.key).sort()).toEqual(["b", "c"]);
  });
});

describe("toSeed", () => {
  test("settles a remote's forgotten value against this machine having none", () => {
    expect(toSeed(["k"], [], [[row("k", "90", 0, "")]])).toEqual(["k"]);
  });

  test("settles this machine's own value from before the engine", () => {
    expect(toSeed(["k"], [row("k", "on", 0, "")], [])).toEqual(["k"]);
  });

  test("leaves a key some copy has a real choice for", () => {
    expect(toSeed(["k"], [], [[row("k", "90", 0, "")], [row("k", "30", 7)]])).toEqual([]);
  });

  test("leaves a key on no copy: a new install must not overwrite a machine it has not heard from", () => {
    expect(toSeed(["k"], [], [])).toEqual([]);
  });

  test("leaves a key it does not know", () => {
    expect(toSeed([], [row("k", "on", 0, "")], [])).toEqual([]);
  });
});

test("newestRevision is zero with nothing chosen", () => {
  expect(newestRevision(new Map())).toBe(0);
  expect(newestRevision(winners([[row("a", "1", 3), row("b", "2", 9)]]))).toBe(9);
});
