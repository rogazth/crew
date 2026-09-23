// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { highlightInline } from "../../lib/shiki";
import { mount, type Mounted } from "../../test/dom";
import { act } from "../../test/renderHook";
import { CodeBlock } from "./CodeBlock";

vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});
vi.mock("@pierre/diffs", () => ({ parseDiffFromFile: () => ({}), parsePatchFiles: () => [] }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));
vi.mock("../../lib/shiki", async (original) => ({
  ...(await original<typeof import("../../lib/shiki")>()),
  highlightInline: vi.fn(async () => "<span>x</span>"),
}));

let view: Mounted | null = null;
const highlight = vi.mocked(highlightInline);

function render(props: { code: string; lang?: string; streaming?: boolean }) {
  view = mount(<CodeBlock {...props} />);
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  highlight.mockClear();
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

describe("highlighting", () => {
  it("waits for 150 ms of quiet before asking for colours", () => {
    render({ code: "let a", lang: "js" });
    advance(149);
    expect(highlight).not.toHaveBeenCalled();
    advance(1);
    expect(highlight).toHaveBeenCalledWith("let a", "javascript");
  });

  it("asks only for the latest code when it changes inside the wait", () => {
    render({ code: "let a", lang: "js" });
    advance(100);
    view!.rerender(<CodeBlock code="let ab" lang="js" />);
    advance(149);
    expect(highlight).not.toHaveBeenCalled();
    advance(1);
    expect(highlight.mock.calls).toEqual([["let ab", "javascript"]]);
  });

  it("waits out a stream and highlights once it ends", () => {
    render({ code: "let a", lang: "ts", streaming: true });
    advance(1000);
    expect(highlight).not.toHaveBeenCalled();
    view!.rerender(<CodeBlock code="let a = 1" lang="ts" />);
    advance(150);
    expect(highlight).toHaveBeenCalledWith("let a = 1", "typescript");
  });

  it("never highlights plain text, unknown languages or diffs", () => {
    render({ code: "hello" });
    view!.rerender(<CodeBlock code="hello" lang="klingon" />);
    view!.rerender(<CodeBlock code={"-a\n+b"} lang="diff" />);
    advance(1000);
    expect(highlight).not.toHaveBeenCalled();
  });

  it("cancels the pending request when it goes away", () => {
    render({ code: "let a", lang: "js" });
    view!.unmount();
    view = null;
    advance(1000);
    expect(highlight).not.toHaveBeenCalled();
  });
});
