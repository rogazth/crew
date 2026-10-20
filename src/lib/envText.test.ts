import { describe, expect, it } from "vitest";
import type { EnvLink } from "./client/registry";
import { bareHost, whereOf } from "./envText";

const link = (patch: Partial<EnvLink>) => ({ ssh: null, host: null, user: null, ...patch }) as EnvLink;

describe("whereOf", () => {
  it("joins the user and an alias or host", () => {
    expect(whereOf(link({ ssh: "box", user: "me" }))).toBe("me@box");
    expect(whereOf(link({ host: "10.0.0.2", user: "me" }))).toBe("me@10.0.0.2");
    expect(whereOf(link({ host: "10.0.0.2" }))).toBe("10.0.0.2");
    expect(whereOf(link({}))).toBe("");
  });

  it("keeps an ssh:// target valid with the user inside it", () => {
    expect(whereOf(link({ ssh: "ssh://box:2222", user: "me" }))).toBe("ssh://me@box:2222");
    expect(whereOf(link({ ssh: "ssh://me@box:2222", user: "me" }))).toBe("ssh://me@box:2222");
    expect(whereOf(link({ ssh: "ssh://box:2222" }))).toBe("ssh://box:2222");
  });
});

describe("bareHost", () => {
  it("drops the scheme, user and port", () => {
    expect(bareHost("ssh://me@box:2222")).toBe("box");
    expect(bareHost("ssh://box:2222")).toBe("box");
    expect(bareHost("box")).toBe("box");
  });
});
