import { describe, expect, it } from "vitest";
import { addAttachments, agentSessionOf, foregroundAgent, outgoing, pastedPaths } from "./agentChat";
import type { ProjectFile, Session, Tab } from "./types";

const session = (id: string, kind: Session["kind"]): Session =>
  ({ id, kind, name: id, workspaceId: "w", provider: "claude", model: "" }) as Session;
const SESSIONS = [session("agent", "agent"), session("shell", "terminal")];
const tabFor = (sessionId: string): Tab => ({ id: `session:${sessionId}`, kind: "session", sessionId });
const FILES: ProjectFile[] = [{ name: "tabs.ts", path: "/w/src/lib/tabs.ts", relative: "src/lib/tabs.ts" }];

describe("addAttachments", () => {
  it("appends new paths once each, keeping what is there", () => {
    const prev = [{ name: "a.png", path: "/t/a.png", kind: "image" as const }];
    expect(addAttachments(prev, ["/t/a.png", "/t/b.md", "/t/b.md", "/t/c.jpg"])).toEqual([
      prev[0],
      { name: "b.md", path: "/t/b.md", kind: "file" },
      { name: "c.jpg", path: "/t/c.jpg", kind: "image" },
    ]);
  });
});

describe("pastedPaths", () => {
  it("keeps the files that were written, in order, and drops the failures", async () => {
    const files = ["one", "two", "three"].map((name) => new File(["x"], name));
    const write = (file: File) =>
      file.name === "two" ? Promise.reject(new Error("disk full")) : Promise.resolve(`/tmp/${file.name}`);
    await expect(pastedPaths(files, write)).resolves.toEqual(["/tmp/one", "/tmp/three"]);
    await expect(pastedPaths([], write)).resolves.toEqual([]);
  });
});

describe("outgoing", () => {
  it("sends the trimmed text with the files and the files it mentions", () => {
    const files = [{ name: "a.png", path: "/t/a.png" }];
    expect(outgoing("  look at @src/lib/tabs.ts \n", files, FILES, false, true)).toEqual({
      text: "look at @src/lib/tabs.ts",
      files,
      options: { mentions: ["/w/src/lib/tabs.ts"] },
    });
  });

  it("sends files alone, and no mention option without mentions", () => {
    const files = [{ name: "a.png", path: "/t/a.png" }];
    expect(outgoing("", files, FILES, false, true)).toEqual({ text: "", files, options: {} });
    expect(outgoing("@nope", [], FILES, false, true)?.options).toEqual({});
  });

  it("refuses an empty draft, a busy agent or one that is not ready", () => {
    expect(outgoing("   ", [], FILES, false, true)).toBeNull();
    expect(outgoing("hi", [], FILES, true, true)).toBeNull();
    expect(outgoing("hi", [], FILES, false, false)).toBeNull();
  });
});

describe("agentSessionOf", () => {
  it("finds the agent a session tab shows", () => {
    expect(agentSessionOf(tabFor("agent"), SESSIONS)?.id).toBe("agent");
  });

  it("is null for terminals, missing sessions and other tabs", () => {
    expect(agentSessionOf(tabFor("shell"), SESSIONS)).toBeNull();
    expect(agentSessionOf(tabFor("gone"), SESSIONS)).toBeNull();
    expect(agentSessionOf({ id: "file:/a", kind: "file", path: "/a", relative: "a" }, SESSIONS)).toBeNull();
  });
});

describe("foregroundAgent", () => {
  it("is the agent in the visible pane", () => {
    const panes = [
      { tab: tabFor("shell"), visible: false },
      { tab: tabFor("agent"), visible: true },
    ];
    expect(foregroundAgent(panes, SESSIONS)).toBe("agent");
  });

  it("is null when the visible pane is not an agent, or nothing is visible", () => {
    expect(foregroundAgent([{ tab: tabFor("shell"), visible: true }], SESSIONS)).toBeNull();
    expect(foregroundAgent([{ tab: tabFor("agent"), visible: false }], SESSIONS)).toBeNull();
    expect(foregroundAgent([], SESSIONS)).toBeNull();
  });
});
