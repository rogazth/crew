// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, only, type Mounted } from "../../test/dom";
import { act } from "../../test/renderHook";
import { CopyButton } from "./CopyButton";

vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});

let view: Mounted | null = null;

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

describe("CopyButton", () => {
  it("copies its text, says so, and goes back after 1.5 s", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    clipboard(writeText);
    view = mount(<CopyButton text="npm test" />);
    await act(async () => click(only(view!.container, "button")));
    expect(writeText).toHaveBeenCalledWith("npm test");
    expect(only(view.container, "button").getAttribute("aria-label")).toBe("Copied");
    act(() => vi.advanceTimersByTime(1500));
    expect(only(view.container, "button").getAttribute("aria-label")).toBe("Copy");
  });

  it("does not claim a copy the clipboard refused", async () => {
    clipboard(vi.fn(async () => Promise.reject(new Error("denied"))));
    view = mount(<CopyButton text="npm test" />);
    await act(async () => click(only(view!.container, "button")));
    expect(only(view.container, "button").getAttribute("aria-label")).toBe("Copy");
  });
});
