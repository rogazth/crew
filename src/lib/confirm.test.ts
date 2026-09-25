import { describe, expect, it } from "vitest";
import { settle } from "./confirm";

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
