// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/blocks";
import type { ProjectFile, Session } from "../lib/types";
import { click, dispatch, mount, only, press, type, type Mounted } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { AgentChat } from "./AgentChat";
import { ChatContext } from "./chat/context";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));
// Thousands of glyphs take seconds to load and none of them is behavior.
vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});
vi.mock("@pierre/diffs", () => ({ parseDiffFromFile: () => ({}), parsePatchFiles: () => [] }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

const PROJECT: ProjectFile[] = [{ name: "tabs.ts", path: "/w/src/lib/tabs.ts", relative: "src/lib/tabs.ts" }];

let count = 0;
let view: Mounted | null = null;
const onModel = vi.fn();
const host = { open: vi.fn<() => Promise<string[] | null>>() };

/** Transcripts are cached per session for the life of the module, so each test gets its own. */
function newSession(): Session {
  count += 1;
  return { id: `agent-${count}`, name: "Ada", kind: "agent", provider: "claude", model: "default" } as Session;
}

function page(blocks: Block[] = [], working = false) {
  return { blocks, fromPos: 0, toPos: blocks.length, more: false, working, status: working ? "working" : "idle" };
}

async function render(session: Session, active = true) {
  const tree = (isActive: boolean) => (
    <ChatContext.Provider value={{ openPath: () => undefined, openSession: () => undefined, files: PROJECT }}>
      <AgentChat session={session} cwd="/w" active={isActive} onModel={onModel} />
    </ChatContext.Provider>
  );
  view = mount(tree(active));
  await vi.waitFor(() => expect(fake.sent("transcript_tail").length).toBeGreaterThan(0));
  await settle();
  return {
    field: () => only<HTMLTextAreaElement>(view!.container, "textarea"),
    activate: () => view!.rerender(tree(true)),
  };
}

/** Lets answered requests land and React commit what they changed. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
}

function button(label: string): HTMLButtonElement {
  return only<HTMLButtonElement>(view!.container, `button[aria-label="${label}"]`);
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...view!.container.querySelectorAll("button")].find((el) => el.textContent === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

beforeEach(() => {
  fake.reset();
  fake.respond("transcript_tail", () => page());
  fake.respond("turn_start", () => ({ working: true }));
  fake.respond("state_get", () => null);
  host.open.mockReset();
  vi.stubGlobal("crewHost", host);
  onModel.mockClear();
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

describe("sending", () => {
  it("sends the trimmed draft with its attachments and the files it mentions, then clears the well", async () => {
    const session = newSession();
    const chat = await render(session);
    host.open.mockResolvedValue(["/t/shot.png", "/t/notes.md"]);
    click(button("Attach files"));
    await settle();
    type(chat.field(), "  fix @src/lib/tabs.ts \n");
    press(chat.field(), "Enter");
    await vi.waitFor(() => expect(fake.sent("turn_start")).toHaveLength(1));
    expect(fake.sent("turn_start")[0]).toMatchObject({
      sessionId: session.id,
      cwd: "/w",
      text: "fix @src/lib/tabs.ts",
      files: [
        { name: "shot.png", path: "/t/shot.png", kind: "image" },
        { name: "notes.md", path: "/t/notes.md", kind: "file" },
      ],
      mentions: ["/w/src/lib/tabs.ts"],
    });
    expect(chat.field().value).toBe("");
    await settle();
    type(chat.field(), "again");
    press(chat.field(), "Enter");
    await vi.waitFor(() => expect(fake.sent("turn_start")).toHaveLength(2));
    expect(fake.sent("turn_start")[1]).not.toHaveProperty("files");
  });

  it("sends nothing for an empty draft", async () => {
    const chat = await render(newSession());
    type(chat.field(), "   ");
    press(chat.field(), "Enter");
    await settle();
    expect(fake.sent("turn_start")).toHaveLength(0);
  });

  it("attaches a picked file once however often it is picked", async () => {
    const chat = await render(newSession());
    host.open.mockResolvedValue(["/t/notes.md"]);
    click(button("Attach files"));
    await settle();
    click(button("Attach files"));
    await settle();
    press(chat.field(), "Enter");
    await vi.waitFor(() => expect(fake.sent("turn_start")).toHaveLength(1));
    expect(fake.sent("turn_start")[0]!.files).toEqual([{ name: "notes.md", path: "/t/notes.md", kind: "file" }]);
  });

  it("attaches nothing when the picker is cancelled", async () => {
    const chat = await render(newSession());
    host.open.mockResolvedValue(null);
    click(button("Attach files"));
    await settle();
    press(chat.field(), "Enter");
    await settle();
    expect(fake.sent("turn_start")).toHaveLength(0);
  });

  it("leaves a removed attachment out", async () => {
    const chat = await render(newSession());
    host.open.mockResolvedValue(["/t/a.md", "/t/b.md"]);
    click(button("Attach files"));
    await settle();
    click(button("Remove a.md"));
    press(chat.field(), "Enter");
    await vi.waitFor(() => expect(fake.sent("turn_start")).toHaveLength(1));
    expect(fake.sent("turn_start")[0]!.files).toEqual([{ name: "b.md", path: "/t/b.md", kind: "file" }]);
  });

  it("stops a running turn", async () => {
    fake.respond("transcript_tail", () => page([], true));
    fake.respond("turn_stop", () => undefined);
    const session = newSession();
    await render(session);
    click(button("Stop"));
    await vi.waitFor(() => expect(fake.sent("turn_stop")).toEqual([{ sessionId: session.id }]));
  });
});

describe("pasting", () => {
  function paste(field: HTMLTextAreaElement, files: File[]) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files, getData: () => "" } });
    dispatch(field, event);
  }

  it("writes a pasted screenshot to a temp file and attaches that path", async () => {
    fake.respond("write_temp_file", () => "/tmp/crew/paste-1.png");
    const chat = await render(newSession());
    paste(chat.field(), [new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(fake.sent("write_temp_file")).toHaveLength(1));
    await settle();
    press(chat.field(), "Enter");
    await vi.waitFor(() => expect(fake.sent("turn_start")).toHaveLength(1));
    expect(fake.sent("turn_start")[0]!.files).toEqual([{ name: "paste-1.png", path: "/tmp/crew/paste-1.png", kind: "image" }]);
  });

  it("drops a paste that could not be written", async () => {
    fake.respond("write_temp_file", () => {
      throw new Error("disk full");
    });
    const chat = await render(newSession());
    paste(chat.field(), [new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(fake.sent("write_temp_file")).toHaveLength(1));
    await settle();
    press(chat.field(), "Enter");
    await settle();
    expect(fake.sent("turn_start")).toHaveLength(0);
  });
});

describe("answering the agent", () => {
  it("responds to an approval for this session", async () => {
    const approval: Block = {
      id: "a1",
      role: "approval",
      text: "Run ls",
      approval: { requestId: 3, name: "Bash", input: { command: "ls" } },
    };
    fake.respond("transcript_tail", () => page([approval], true));
    fake.respond("turn_respond", () => undefined);
    const session = newSession();
    await render(session);
    click(buttonNamed("Always allow"));
    expect(fake.sent("turn_respond")).toEqual([{ sessionId: session.id, requestId: 3, decision: "always" }]);
  });

  it("answers a question for this session", async () => {
    const question: Block = {
      id: "q1",
      role: "question",
      text: "Pick",
      question: {
        requestId: 9,
        questions: [{ question: "Which?", header: "Which", multiSelect: false, options: [{ label: "A" }] }],
      },
    };
    fake.respond("transcript_tail", () => page([question], true));
    fake.respond("turn_answer", () => undefined);
    const session = newSession();
    await render(session);
    click(buttonNamed("Dismiss"));
    expect(fake.sent("turn_answer")).toEqual([{ sessionId: session.id, requestId: 9, answers: null }]);
  });
});

describe("focus", () => {
  it("puts the caret in the well when the tab becomes active", async () => {
    const chat = await render(newSession(), false);
    expect(document.activeElement).not.toBe(chat.field());
    chat.activate();
    expect(document.activeElement).toBe(chat.field());
  });
});
