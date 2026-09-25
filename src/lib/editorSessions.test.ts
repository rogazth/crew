import { describe, expect, it } from "vitest";
import { editorSessions } from "./editorSessions";

let made = 0;
const create = () => ({ n: ++made });

describe("editorSessions", () => {
  it("takes a file's session up again while it holds the text the file starts from", () => {
    const sessions = editorSessions<{ n: number }>(4);
    const first = sessions.take("/a.ts", "v1", create);
    expect(sessions.take("/a.ts", "v1", create)).toBe(first);
    sessions.edited("/a.ts", first, "v1 mine");
    expect(sessions.take("/a.ts", "v1 mine", create)).toBe(first);
  });

  it("starts afresh from text the session does not hold, and keeps that one instead", () => {
    const sessions = editorSessions<{ n: number }>(4);
    const first = sessions.take("/a.ts", "v1", create);
    sessions.edited("/a.ts", first, "v1 mine");
    const reloaded = sessions.take("/a.ts", "v2", create);
    expect(reloaded).not.toBe(first);
    expect(sessions.take("/a.ts", "v2", create)).toBe(reloaded);
    expect(sessions.take("/a.ts", "v1 mine", create)).not.toBe(first);
  });

  it("ignores an edit from a session the file no longer keeps", () => {
    const sessions = editorSessions<{ n: number }>(4);
    const stale = sessions.take("/a.ts", "v1", create);
    const current = sessions.take("/a.ts", "v2", create);
    sessions.edited("/a.ts", stale, "v2 stale");
    expect(sessions.take("/a.ts", "v2", create)).toBe(current);
  });

  it("keeps each file's session apart", () => {
    const sessions = editorSessions<{ n: number }>(4);
    const a = sessions.take("/a.ts", "same", create);
    const b = sessions.take("/b.ts", "same", create);
    expect(b).not.toBe(a);
    expect(sessions.take("/a.ts", "same", create)).toBe(a);
  });

  it("drops the least recently taken session past the limit", () => {
    const sessions = editorSessions<{ n: number }>(2);
    const a = sessions.take("/a.ts", "a", create);
    const b = sessions.take("/b.ts", "b", create);
    // Taking /a.ts again makes /b.ts the oldest.
    expect(sessions.take("/a.ts", "a", create)).toBe(a);
    sessions.take("/c.ts", "c", create);
    expect(sessions.take("/a.ts", "a", create)).toBe(a);
    expect(sessions.take("/b.ts", "b", create)).not.toBe(b);
  });
});
