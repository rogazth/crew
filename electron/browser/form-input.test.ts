import { describe, expect, it } from "vitest";
import { watchFormInput } from "./form-input";

type Listener = (event: { isTrusted: boolean; composedPath(): unknown[] }) => void;

function harness(active = true) {
  let listener: Listener | null = null;
  const target = {
    addEventListener: (_: "input", fn: Listener) => {
      listener = fn;
    },
    removeEventListener: (_: "input", fn: Listener) => {
      if (listener === fn) listener = null;
    },
  };
  let reports = 0;
  const state = { active };
  watchFormInput(target, () => state.active, () => reports++);
  return {
    state,
    reports: () => reports,
    listening: () => listener !== null,
    fire: (node: unknown, isTrusted = true) => listener?.({ isTrusted, composedPath: () => [node] }),
  };
}

const field = (tagName: string) => ({ tagName, isContentEditable: false });

describe("watchFormInput", () => {
  it("reports the first typing into a field once, then stops listening", () => {
    const h = harness();
    h.fire(field("INPUT"));
    h.fire(field("INPUT"));
    expect(h.reports()).toBe(1);
    expect(h.listening()).toBe(false);
  });

  it("counts inputs, text areas, selects and editable text", () => {
    for (const node of [field("INPUT"), field("textarea"), field("SELECT"), { tagName: "DIV", isContentEditable: true }]) {
      const h = harness();
      h.fire(node);
      expect(h.reports()).toBe(1);
    }
  });

  it("ignores events the page dispatched itself", () => {
    const h = harness();
    h.fire(field("INPUT"), false);
    expect(h.reports()).toBe(0);
    expect(h.listening()).toBe(true);
  });

  it("ignores trusted events with no user gesture behind them, as execCommand fires", () => {
    const h = harness(false);
    h.fire(field("TEXTAREA"));
    expect(h.reports()).toBe(0);
    h.state.active = true;
    h.fire(field("TEXTAREA"));
    expect(h.reports()).toBe(1);
  });

  it("ignores input on anything that is not a field", () => {
    const h = harness();
    for (const node of [{ tagName: "DIV", isContentEditable: false }, null, "INPUT", {}]) h.fire(node);
    expect(h.reports()).toBe(0);
  });
});
