// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, only, type Mounted } from "../../test/dom";
import { act } from "../../test/renderHook";
import { highlightInline } from "../../lib/shiki";
import { ChatContext } from "./context";
import { Markdown } from "./Markdown";

vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});
vi.mock("@pierre/diffs", () => ({ parseDiffFromFile: () => ({}), parsePatchFiles: () => [] }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));
vi.mock("../../lib/shiki", async (original) => ({
  ...(await original<typeof import("../../lib/shiki")>()),
  highlightInline: vi.fn(async () => null),
}));

/**
 * Streamdown stands in as the least markdown these tests need: a fence, links
 * and inline code, each handed to the components Crew gives it.
 */
vi.mock("streamdown", async () => {
  const { createElement, Fragment } = await import("react");
  type Part = import("react").ComponentType<Record<string, unknown>>;
  function Streamdown({ children, components }: { children: string; components: Record<"a" | "code" | "pre", Part> }) {
    const { a, code, pre } = components;
    const fence = /^```([\w+-]*)\n([\s\S]*?)```\s*$/.exec(children);
    if (fence) {
      const className = fence[1] ? `language-${fence[1]}` : undefined;
      return createElement(pre, null, createElement(code, { className }, fence[2]));
    }
    const parts = children.split(/(\[[^\]]*\]\([^)]*\)|`[^`]+`)/);
    return createElement(
      "p",
      null,
      parts.map((part, key) => {
        const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(part);
        if (link) return createElement(a, { key, href: link[2] }, link[1]);
        const inline = /^`([^`]+)`$/.exec(part);
        if (inline) return createElement(code, { key }, inline[1]);
        return createElement(Fragment, { key }, part);
      }),
    );
  }
  return { Streamdown };
});

let view: Mounted | null = null;
const openPath = vi.fn<(path: string) => void>();
const openUrl = vi.fn(async () => undefined);

function render(text: string, streaming = false) {
  view = mount(
    <ChatContext.Provider value={{ openPath, openSession: () => undefined, files: [] }}>
      <Markdown text={text} streaming={streaming} />
    </ChatContext.Provider>,
  );
  return view.container;
}

const link = (name: string) => [...view!.container.querySelectorAll("a")].find((a) => a.textContent === name)!;

beforeEach(() => {
  openPath.mockClear();
  openUrl.mockClear();
  vi.mocked(highlightInline).mockClear();
  vi.stubGlobal("crewHost", { openUrl });
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("links", () => {
  it("opens web and mail links in the default browser, never in the window", () => {
    render("See [docs](https://example.com/docs) or [mail](mailto:a@b.c).");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link("docs").dispatchEvent(event);
    });
    click(link("mail"));
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl.mock.calls).toEqual([["https://example.com/docs"], ["mailto:a@b.c"]]);
  });

  it("does not follow a script link an agent wrote", () => {
    render("Click [here](javascript:alert(1)).");
    click(link("here"));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("scrolls to a footnote inside the message instead of leaving", () => {
    const note = document.createElement("li");
    note.id = "fn-1";
    document.body.appendChild(note);
    const scroll = vi.fn();
    note.scrollIntoView = scroll;
    render("A claim [1](#fn-1).");
    click(link("1"));
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(openUrl).not.toHaveBeenCalled();
    note.remove();
  });

  it("goes nowhere for streamdown's own placeholders", () => {
    render("Half a [link](streamdown:incomplete-link).");
    click(link("link"));
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("inline code", () => {
  it("opens a file it names", () => {
    render("Changed `src/lib/tabs.ts` today.");
    click(only(view!.container, 'button[title="src/lib/tabs.ts"]'));
    expect(openPath).toHaveBeenCalledWith("src/lib/tabs.ts");
  });

  it("leaves other code as code", () => {
    render("Run `npm run build` first.");
    expect(view!.container.querySelector('button[title="npm run build"]')).toBeNull();
  });
});

describe("fences", () => {
  it("highlight their code in the fence's language once it settles", () => {
    vi.useFakeTimers();
    render("```ts\nconst a = 1;\n```");
    act(() => vi.advanceTimersByTime(150));
    expect(highlightInline).toHaveBeenCalledWith("const a = 1;", "typescript");
  });

  it("stay plain without a language", () => {
    vi.useFakeTimers();
    render("```\nplain words\n```");
    act(() => vi.advanceTimersByTime(1000));
    expect(highlightInline).not.toHaveBeenCalled();
  });
});

describe("copying", () => {
  it("copies a prose run without its trailing space", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render("Hello there\n\n");
    await act(async () => click(only(view!.container, 'button[aria-label="Copy"]')));
    expect(writeText).toHaveBeenCalledWith("Hello there");
  });
});
