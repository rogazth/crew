import { describe, expect, it } from "vitest";
import { toastText } from "./toasts";

const target = { workspaceId: "w1", sessionId: "s1" };

describe("toastText", () => {
  it("says what a session did after its name", () => {
    expect(toastText({ title: "Planner", body: "Asks: which one?", source: "needs-input", target })).toEqual({
      title: "Planner needs your answer",
      description: "Asks: which one?",
    });
  });

  it("drops a body that repeats the verb", () => {
    expect(toastText({ title: "Planner", body: "Needs your input", source: "needs-input", target }).description).toBeNull();
    expect(toastText({ title: "Planner", body: "Ran into an error", source: "error", target }).description).toBeNull();
  });

  it("leaves news without a session as it came", () => {
    expect(toastText({ title: "Could not save a setting", body: "Disk full", source: "error", target: null })).toEqual({
      title: "Could not save a setting",
      description: "Disk full",
    });
    expect(toastText({ title: "devbox", body: "Back online", source: "connection", target: null }).title).toBe("devbox");
    expect(toastText({ title: "web", body: "Exited with code 1", source: "process", target: null }).title).toBe("web");
  });
});
