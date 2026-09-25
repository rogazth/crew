import { describe, expect, it } from "vitest";
import { closePrompt, settle, unsavedCost } from "./confirm";

describe("settle", () => {
  it("is done when the action resolves to nothing", async () => {
    expect(await settle(Promise.resolve())).toEqual({ kind: "done" });
  });

  it("asks again when the action resolves to another prompt", async () => {
    const next = { title: "Again?" };
    expect(await settle(Promise.resolve(next))).toEqual({ kind: "ask", next });
  });

  it("turns a refusal into the line the prompt shows", async () => {
    expect(await settle(Promise.reject(new Error("/wt/feat has uncommitted changes")))).toEqual({
      kind: "failed",
      error: "/wt/feat has uncommitted changes",
    });
    // Whatever was thrown, not only an Error, has a line to show.
    expect(await settle(Promise.reject("not a git repository"))).toEqual({
      kind: "failed",
      error: "not a git repository",
    });
  });
});

describe("closePrompt", () => {
  const working = { name: "dev server", label: "is still working" };

  it("asks nothing when no terminal runs and no file is unsaved", () => {
    expect(closePrompt(1, [], [])).toBeNull();
    expect(closePrompt(3, [], [])).toBeNull();
  });

  it("names the one file a close would lose edits of, and offers to discard them", () => {
    expect(closePrompt(1, [], ["app.ts"])).toEqual({
      title: 'Close "app.ts"?',
      description: "Unsaved changes are lost.",
      action: "Discard",
    });
  });

  it("names the one running terminal as before", () => {
    expect(closePrompt(1, [working], [])).toEqual({
      title: 'Close "dev server"?',
      description: "It is still working. Closing the tab ends the process; the session stays in the sidebar.",
      action: "Close",
    });
  });

  it("asks once for a batch, counting unsaved files alongside running terminals", () => {
    expect(closePrompt(3, [], ["a.ts", "b.md"])).toEqual({
      title: "Close 3 tabs?",
      description: "2 files have unsaved changes, which are lost.",
      action: "Close",
    });
    expect(closePrompt(4, [working], ["a.ts"])).toEqual({
      title: "Close 4 tabs?",
      description:
        '"dev server" is still running. Closing ends its process; the sessions stay in the sidebar. "a.ts" has unsaved changes, which are lost.',
      action: "Close",
    });
    expect(closePrompt(2, [working, { ...working, name: "tests" }], [])?.description).toBe(
      "2 sessions are still running. Closing ends their processes; the sessions stay in the sidebar.",
    );
  });
});

describe("unsavedCost", () => {
  it("is empty with nothing unsaved, names one file, and counts several", () => {
    expect(unsavedCost([])).toBe("");
    expect(unsavedCost(["plan.md"])).toBe('"plan.md" has unsaved changes, which are lost.');
    expect(unsavedCost(["a.ts", "b.ts", "c.ts"])).toBe("3 files have unsaved changes, which are lost.");
  });
});
