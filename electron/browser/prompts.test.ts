import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { answer, ask, dropHost, dropPrompts, parseAnswer } from "./prompts";

class Host extends EventEmitter {
  sent: [string, unknown][] = [];
  destroyed = false;
  isDestroyed = () => this.destroyed;
  send = (channel: string, value: unknown) => this.sent.push([channel, value]);
}

const request = { kind: "external", origin: "https://a.com", app: "zoom.us", scheme: "zoommtg" } as const;
const idOf = (host: Host, n = 0) => (host.sent.filter(([c]) => c === "browser:prompt")[n]?.[1] as { id: string }).id;

describe("prompts", () => {
  it("shows a question over its page and resolves with the answer", async () => {
    const host = new Host();
    const pending = ask({ host: host as never, pageId: 7 }, request);
    expect(host.sent[0]).toEqual(["browser:prompt", expect.objectContaining({ ...request, webContentsId: 7 })]);
    answer(host as never, idOf(host), { open: true });
    expect(await pending).toEqual({ open: true });
  });

  it("answers null for a window that is already gone", async () => {
    const host = new Host();
    host.destroyed = true;
    expect(await ask({ host: host as never, pageId: 1 }, request)).toBeNull();
    expect(host.sent).toEqual([]);
  });

  it("answers a page's open questions null when it goes, and tells the window", async () => {
    const host = new Host();
    const first = ask({ host: host as never, pageId: 3 }, request);
    const other = ask({ host: host as never, pageId: 4 }, request);
    dropPrompts(3);
    expect(await first).toBeNull();
    expect(host.sent).toContainEqual(["browser:prompt-gone", idOf(host, 0)]);
    answer(host as never, idOf(host, 1), { open: false });
    expect(await other).toEqual({ open: false });
  });

  it("answers a closed window's questions null", async () => {
    const host = new Host();
    const pending = ask({ host: host as never, pageId: 5 }, request);
    dropHost(host as never);
    expect(await pending).toBeNull();
  });

  it("refuses more than a handful of open questions from one page", async () => {
    const host = new Host();
    const asked = Array.from({ length: 10 }, () => ask({ host: host as never, pageId: 9 }, request));
    expect(await asked[9]).toBeNull();
    expect(host.sent.filter(([c]) => c === "browser:prompt")).toHaveLength(8);
    dropPrompts(9);
    await Promise.all(asked);
  });
});

describe("parseAnswer", () => {
  it.each([
    [{ allow: true, remember: true }, { allow: true, remember: true }],
    [{ allow: false }, { allow: false, remember: false }],
    [{ username: "me", password: "pw" }, { username: "me", password: "pw" }],
    [{ open: true }, { open: true }],
    [{ settings: false }, { settings: false }],
  ])("keeps %j", (value, expected) => {
    expect(parseAnswer(value)).toEqual(expected);
  });

  it.each([null, undefined, "yes", 1, {}, { allow: "yes" }, { username: "me" }, { username: "x".repeat(2000), password: "" }])(
    "reads %j as no answer",
    (value) => {
      expect(parseAnswer(value)).toBeNull();
    },
  );
});
