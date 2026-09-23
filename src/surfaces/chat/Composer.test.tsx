// @vitest-environment happy-dom
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachedFile } from "../../lib/blocks";
import type { ProjectFile, Session } from "../../lib/types";
import { fake } from "../../test/fakeClient";
import { click, dispatch, mount, only, press, type, type Mounted } from "../../test/dom";
import { Composer } from "./Composer";
import { ChatContext } from "./context";

vi.mock("../../lib/client", async () => ({ client: (await import("../../test/fakeClient")).fake.client }));
// Thousands of glyphs take seconds to load and none of them is behavior.
vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});

const SESSION = { id: "s1", name: "Ada", provider: "claude", model: "default", kind: "agent" } as Session;
const FILES: ProjectFile[] = [
  { name: "tabs.ts", path: "/w/src/lib/tabs.ts", relative: "src/lib/tabs.ts" },
  { name: "tables.css", path: "/w/src/tables.css", relative: "src/tables.css" },
];

type Options = { draft?: string; files?: AttachedFile[]; working?: boolean; ready?: boolean };

let view: Mounted | null = null;
const spies = {
  onDraft: vi.fn<(value: string) => void>(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onAttach: vi.fn(),
  onPasteFiles: vi.fn<(files: File[]) => void>(),
  onRemoveFile: vi.fn<(path: string) => void>(),
};

/** The composer is controlled; this holds the draft the way AgentChat does. */
function Harness({ draft: initial = "", files = [], working = false, ready = true, field }: Options & { field?: React.Ref<HTMLTextAreaElement> }) {
  const [draft, setDraft] = useState(initial);
  return (
    <ChatContext.Provider value={{ openPath: () => undefined, openSession: () => undefined, files: FILES }}>
      <Composer
        {...(field ? { ref: field } : {})}
        session={SESSION}
        draft={draft}
        files={files}
        working={working}
        ready={ready}
        onDraft={(value) => {
          setDraft(value);
          spies.onDraft(value);
        }}
        onModel={() => undefined}
        onAttach={spies.onAttach}
        onPasteFiles={spies.onPasteFiles}
        onRemoveFile={spies.onRemoveFile}
        onSend={spies.onSend}
        onStop={spies.onStop}
      />
    </ChatContext.Provider>
  );
}

function render(options: Options = {}) {
  view = mount(<Harness {...options} />);
  return only<HTMLTextAreaElement>(view.container, "textarea");
}

const sendButton = () => only<HTMLButtonElement>(view!.container, 'button[type="submit"]');
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];

beforeEach(() => {
  fake.reset();
  for (const spy of Object.values(spies)) spy.mockClear();
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe("sending", () => {
  it("sends on Enter and keeps the key from typing a newline", () => {
    const field = render({ draft: "  hello  " });
    expect(press(field, "Enter")).toBe(true);
    expect(spies.onSend).toHaveBeenCalledTimes(1);
  });

  it("leaves Shift+Enter to the field as a newline", () => {
    const field = render({ draft: "hello" });
    expect(press(field, "Enter", { shiftKey: true })).toBe(false);
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("does not send while an IME is composing", () => {
    const field = render({ draft: "こんにちは" });
    expect(press(field, "Enter", { isComposing: true })).toBe(false);
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("refuses an empty or blank draft", () => {
    const field = render({ draft: "   " });
    press(field, "Enter");
    click(sendButton());
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);
  });

  it("sends attachments without text", () => {
    const field = render({ files: [{ name: "a.png", path: "/t/a.png", kind: "image" }] });
    press(field, "Enter");
    expect(spies.onSend).toHaveBeenCalledTimes(1);
  });

  it("holds the message until the agent is ready", () => {
    const field = render({ draft: "hello", ready: false });
    press(field, "Enter");
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("sends from the button", () => {
    render({ draft: "hello" });
    click(sendButton());
    expect(spies.onSend).toHaveBeenCalledTimes(1);
  });

  it("stops the running turn from Enter or the button instead of sending", () => {
    const field = render({ draft: "next", working: true });
    press(field, "Enter");
    click(only(view!.container, 'button[aria-label="Stop"]'));
    expect(spies.onStop).toHaveBeenCalledTimes(2);
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("hands its field to the ref so the chat can focus it", () => {
    const field = createRef<HTMLTextAreaElement>();
    view = mount(<Harness field={field} />);
    expect(field.current).toBe(only(view.container, "textarea"));
  });
});

describe("typing", () => {
  it("reports each edit as the new draft", () => {
    const field = render();
    type(field, "hi");
    expect(spies.onDraft).toHaveBeenLastCalledWith("hi");
  });
});

describe("mentions", () => {
  it("offers files for an @ at the caret and inserts the picked one on Enter instead of sending", () => {
    const field = render();
    type(field, "fix @lib");
    expect(options()).toHaveLength(1);
    expect(press(field, "Enter")).toBe(true);
    expect(spies.onDraft).toHaveBeenLastCalledWith("fix @src/lib/tabs.ts ");
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("moves down the results with the arrows and picks with Tab", () => {
    const field = render();
    type(field, "@ta");
    expect(options().map((option) => option.textContent)).toEqual(["tables.csssrc", "tabs.tssrc/lib"]);
    press(field, "ArrowDown");
    expect(press(field, "Tab")).toBe(true);
    expect(spies.onDraft).toHaveBeenLastCalledWith("@src/lib/tabs.ts ");
  });

  it("wraps past either end", () => {
    const field = render();
    type(field, "@ta");
    press(field, "ArrowDown");
    press(field, "ArrowDown");
    press(field, "Enter");
    expect(spies.onDraft).toHaveBeenLastCalledWith("@src/tables.css ");
    type(field, "@ta");
    press(field, "ArrowUp");
    press(field, "Enter");
    expect(spies.onDraft).toHaveBeenLastCalledWith("@src/lib/tabs.ts ");
  });

  it("picks a result with a click", () => {
    const field = render();
    type(field, "see @lib");
    click(options()[0]!);
    expect(spies.onDraft).toHaveBeenLastCalledWith("see @src/lib/tabs.ts ");
  });

  it("closes the picker on Escape, after which Enter sends", () => {
    const field = render();
    type(field, "@ta");
    expect(press(field, "Escape")).toBe(true);
    expect(options()).toHaveLength(0);
    press(field, "Enter");
    expect(spies.onSend).toHaveBeenCalledTimes(1);
  });

  it("closes the picker when the field loses focus", () => {
    const field = render();
    type(field, "@ta");
    dispatch(field, new FocusEvent("focusout", { bubbles: true }));
    expect(options()).toHaveLength(0);
  });

  it("sends on Enter when nothing matches the @", () => {
    const field = render();
    type(field, "@zzz");
    press(field, "Enter");
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    expect(spies.onDraft).toHaveBeenLastCalledWith("@zzz");
  });
});

describe("attachments", () => {
  function paste(field: HTMLTextAreaElement, files: File[], text = "") {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files, getData: () => text, types: text ? ["text/plain"] : ["Files"] },
    });
    dispatch(field, event);
    return event.defaultPrevented;
  }

  it("hands pasted files over and keeps them out of the text", () => {
    const field = render();
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    expect(paste(field, [shot])).toBe(true);
    expect(spies.onPasteFiles).toHaveBeenCalledWith([shot]);
  });

  it("lets pasted text through to the field", () => {
    const field = render();
    expect(paste(field, [], "some text")).toBe(false);
    expect(spies.onPasteFiles).not.toHaveBeenCalled();
  });

  it("opens the picker from the plus and removes a file from its chip", () => {
    render({ files: [{ name: "notes.md", path: "/t/notes.md", kind: "file" }] });
    click(only(view!.container, 'button[aria-label="Attach files"]'));
    click(only(view!.container, 'button[aria-label="Remove notes.md"]'));
    expect(spies.onAttach).toHaveBeenCalledTimes(1);
    expect(spies.onRemoveFile).toHaveBeenCalledWith("/t/notes.md");
  });
});
