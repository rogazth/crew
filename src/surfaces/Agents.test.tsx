// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../lib/agentRuntime";
import type { Pane } from "../lib/tabs";
import type { Session } from "../lib/types";
import { mount, type Mounted } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { Agents } from "./Agents";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));
vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});

const SHELL = { id: "sh", name: "Shell", kind: "terminal", provider: "claude", model: "default" } as Session;

function pane(session: Session, visible: boolean): Pane & { cwd: string } {
  return {
    id: `w/session:${session.id}`,
    workspaceId: "w",
    tab: { id: `session:${session.id}`, kind: "session", sessionId: session.id },
    visible,
    cwd: "/w",
  };
}

let count = 0;
let agent: Session;
let view: Mounted | null = null;

/** The agent on screen, or the shell in front of it. */
const tree = (agentVisible: boolean) => (
  <Agents panes={[pane(agent, agentVisible), pane(SHELL, !agentVisible)]} sessions={[agent, SHELL]} onModel={() => undefined} />
);

/** A turn of the agent's that just finished, as the daemon reports it. */
function finish() {
  act(() => fake.emit("session-status", { sessionId: agent.id, status: "done", updatedAt: 1 }));
}

// The runtime subscribes to the daemon once per module and keeps statuses per
// session, so it boots once here and every test brings its own agent.
beforeAll(async () => {
  fake.reset();
  fake.respond("transcript_tail", () => ({ blocks: [], fromPos: 0, toPos: 0, more: false, working: false, status: "idle" }));
  fake.respond("session_mark_read", () => undefined);
  await boot();
});

beforeEach(() => {
  count += 1;
  agent = { id: `agent-${count}`, name: "Ada", kind: "agent", provider: "claude", model: "default" } as Session;
  fake.client.request.mockClear();
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe("Agents", () => {
  it("treats the agent on screen as read: its finished turn ends quiet", () => {
    view = mount(tree(true));
    finish();
    expect(fake.sent("session_mark_read")).toEqual([{ id: agent.id }]);
  });

  it("leaves a finished turn flagged behind another tab, and marks it read once shown", () => {
    view = mount(tree(false));
    finish();
    expect(fake.sent("session_mark_read")).toEqual([]);
    view.rerender(tree(true));
    expect(fake.sent("session_mark_read")).toEqual([{ id: agent.id }]);
  });

  it("lets go of the foreground when it unmounts", () => {
    view = mount(tree(true));
    view.unmount();
    view = null;
    finish();
    expect(fake.sent("session_mark_read")).toEqual([]);
  });
});
